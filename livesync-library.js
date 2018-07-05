const net = require("net"),
    fs = require("fs"),
    path = require("path"),
    adbInterface = require("./adb-interface.js"),
    crypto = require("crypto"),
    recursive = require("recursive-readdir");

module.exports = (function () {
    const DEFAULT_PORT = 18182,
        PROTOCOL_VERSION_LENGTH_SIZE = 1,
        PROTOCOL_OPERATION_LENGTH_SIZE = 1,
        SIZE_BYTE_LENGTH = 1,
        DELETE_FILE_OPERATION = 7,
        CREATE_FILE_OPERATION = 8,
        DO_SYNC_OPERATION = 9,
        ERROR_REPORT = 1,
        OPERATION_END_REPORT = 2;

    class LivesyncTool {
        constructor() {
            this.initialized = false;
            this.operationPromises = new Map();
            this.socketError = null;
        }

        connect(configurations) {
            this.configurations = configurations;
            this.initialized = false;
            this.configurations.port = this.configurations.port || DEFAULT_PORT;
            this.configurations.localHostAddress = this.configurations.localHostAddress || "127.0.0.1";
            this.socketError = null;

            if (!configurations.fullApplicationName) {
                return Promise.reject(Error(`You need to provide "fullApplicationName" as a configuration property!`));
            }

            if (!configurations.baseDir) {
                return Promise.reject(new Error(`You need to provide "baseDir" as a configuration property!`));
            }

            return adbInterface
                .init(this.configurations)
                .then(this._connectEventuallyUntilTimeout.bind(this, this._createSocket.bind(this), 30000))
                .then(this._handleConnection.bind(this), (err) => {
                    console.log("This tool expects a connected device or emulator!");
                    throw err;
                });
        }

        sendFile(fileName, basePath) {
            return this._sendFileHeader(fileName, basePath)
                .then(this._sendFileContent.bind(this, fileName));
        }

        _sendFileHeader(fileName, basePath) {
            return new Promise(function (resolve, reject) {
                let error;
                this._verifyActiveConnection(reject);
                const fileNameData = this._getFileNameData(fileName, basePath),
                    stats = fs.statSync(fileNameData.fileName),
                    fileContentLengthBytes = stats.size,
                    fileContentLengthString = fileContentLengthBytes.toString(),
                    fileContentLengthSize = Buffer.byteLength(fileContentLengthString),
                    headerBuffer = Buffer.alloc(PROTOCOL_OPERATION_LENGTH_SIZE +
                        SIZE_BYTE_LENGTH +
                        fileNameData.fileNameLengthSize +
                        fileNameData.fileNameLengthBytes +
                        SIZE_BYTE_LENGTH +
                        fileContentLengthSize);

                if (fileNameData.fileNameLengthSize > 255) {
                    error = this._getErrorWithMessage("File name size is longer that 255 digits.");
                } else if (fileContentLengthSize > 255) {
                    error = this._getErrorWithMessage("File name size is longer that 255 digits.");
                }

                if (error) {
                    reject(error);
                }

                let offset = 0;
                offset += headerBuffer.write(CREATE_FILE_OPERATION.toString(), offset, PROTOCOL_OPERATION_LENGTH_SIZE);
                offset = headerBuffer.writeUInt8(fileNameData.fileNameLengthSize, offset);
                offset += headerBuffer.write(fileNameData.fileNameLengthString, offset, fileNameData.fileNameLengthSize);
                offset += headerBuffer.write(fileNameData.relativeFileName, offset, fileNameData.fileNameLengthBytes);
                offset = headerBuffer.writeUInt8(fileContentLengthSize, offset);
                headerBuffer.write(fileContentLengthString, offset, fileContentLengthSize);
                const hash = crypto.createHash("md5").update(headerBuffer).digest();

                this.socketConnection.write(headerBuffer);
                this.socketConnection.write(hash);
                resolve();
            }.bind(this));
        }

        _sendFileContent(fileName) {
            return new Promise(function (resolve, reject) {
                this._verifyActiveConnection(reject);
                const fileStream = fs.createReadStream(fileName),
                    fileHash = crypto.createHash("md5");

                fileStream.on("data", function (chunk) {
                    fileHash.update(chunk);
                    if (this.socketConnection) {
                        this.socketConnection.write(chunk);
                    } else {
                        const error = this._checkConnectionStatus();
                        reject(error);
                    }
                }.bind(this)).on("end", function () {
                    if (this.socketConnection) {
                        this.socketConnection.write(fileHash.digest(), () => {
                            resolve(true);
                        });
                    } else {
                        const error = this._checkConnectionStatus();
                        reject(error);
                    }
                }.bind(this)).on("error", (error) => {
                    reject(error);
                });
            }.bind(this));
        }

        deleteFile(fileName, basePath) {
            return new Promise(function (resolve, reject) {
                this._verifyActiveConnection(reject);
                const fileNameData = this._getFileNameData(fileName, basePath),
                    headerBuffer = Buffer.alloc(PROTOCOL_OPERATION_LENGTH_SIZE +
                        fileNameData.fileNameLengthSizeSize +
                        fileNameData.fileNameLengthSize +
                        fileNameData.fileNameLengthBytes);

                let offset = 0;
                offset += headerBuffer.write(DELETE_FILE_OPERATION.toString(), offset, PROTOCOL_OPERATION_LENGTH_SIZE);
                offset = headerBuffer.writeInt8(fileNameData.fileNameLengthSize, offset);
                offset += headerBuffer.write(fileNameData.fileNameLengthString, offset, fileNameData.fileNameLengthSize);
                headerBuffer.write(fileNameData.relativeFileName, offset, fileNameData.fileNameLengthBytes);
                const hash = crypto.createHash("md5").update(headerBuffer).digest();

                this.socketConnection.write(headerBuffer);
                this.socketConnection.write(hash, () => {
                    resolve(true);
                });
            }.bind(this));
        }

        sendDirectory(dir) {
            return new Promise(function (resolve, reject) {
                recursive(dir, function (err, list) {
                    this.sendFilesArray.call(this, list).then(() => {
                        resolve(list);
                    }, (error) => {
                        reject(error);
                    });
                }.bind(this));
            }.bind(this));
        }

        sendFilesArray(filesArr) {
            const reducer = function (promise, file) {
                if (!fs.lstatSync(file).isDirectory()) {
                    if (!fs.existsSync(file)) {
                        console.log(`${file} doesn't exist.\nThis tool works only with absolute paths!`);
                    }

                    return promise.then(function () {
                        return this.sendFile.call(this, file);
                    }.bind(this));
                }

                return promise;
            };

            return filesArr.reduce(reducer.bind(this), Promise.resolve());
        }

        removeFilesArray(filesArr) {
            const removeFilesPromises = [];

            filesArr.forEach(file => {
                removeFilesPromises.push(this.deleteFile(file));
            });

            return Promise.all(removeFilesPromises);
        }

        sendDoSyncOperation(operationId, timeout) {
            const id = operationId || this.generateOperationUid(),
                operationPromise = new Promise(function (resolve, reject) {
                    this._verifyActiveConnection(reject);
                    if (this.socketConnection === null && this.socketError) {
                        reject(this.socketError);
                    }

                    const message = `${DO_SYNC_OPERATION}${id}`,
                        socketId = this.socketConnection.uid,
                        hash = crypto.createHash("md5").update(message).digest();

                    this.operationPromises.set(id, {
                        resolve,
                        reject,
                        socketId
                    });

                    this.socketConnection.write(message);
                    this.socketConnection.write(hash);

                    setTimeout(function () {
                        if (this.isOperationInProgress(id)) {
                            this._handleSocketError(socketId, "Sync operation is taking too long");
                        }
                    }.bind(this), 6000);
                }.bind(this));

            return operationPromise;
        }

        end() {
            this.socketConnection.end();
        }

        isOperationInProgress(operationId) {
            return !!this.operationPromises.get(operationId);
        }

        generateOperationUid() {
            return crypto.randomBytes(16).toString("hex");
        }

        _createSocket() {
            const { port, localHostAddress } = this.configurations,
                socket = new net.Socket();

            socket.connect(port, localHostAddress);

            return socket;
        }

        _checkConnectionStatus() {
            if (this.socketConnection === null) {
                const defaultError = this._getErrorWithMessage("No socket connection available."),
                    error = this.socketError || defaultError;

                return error;
            }
        }

        _verifyActiveConnection(rejectHandler) {
            const error = this._checkConnectionStatus();
            if (error) {
                rejectHandler(error);
            }
        }

        _handleConnection({ socket, data }) {
            return new Promise(function (resolve, reject) {
                socket.uid = crypto.randomBytes(16).toString("hex");
                this.socketConnection = socket;
                this.socketConnection.uid = crypto.randomBytes(16).toString("hex");
                const versionLength = data.readUInt8(),
                    versionBuffer = data.slice(PROTOCOL_VERSION_LENGTH_SIZE, versionLength + PROTOCOL_VERSION_LENGTH_SIZE),
                    applicationIdentifierBuffer = data.slice(versionLength + PROTOCOL_VERSION_LENGTH_SIZE, data.length);

                this.protocolVersion = versionBuffer.toString();
                this.applicationIdentifier = applicationIdentifierBuffer.toString();
                this.baseDir = this.configurations.baseDir;
                this.initialized = true;
                this.socketConnection.on("data", this._handleData.bind(this, socket.uid));

                this.socketConnection.on("close", this._handleSocketClose.bind(this, socket.uid));

                this.socketConnection.on("error", function (err) {
                    this.initialized = false;
                    const error = new Error(`Socket Error:\n${err}`);
                    if (this.configurations.errorHandler) {
                        this.configurations.errorHandler(error);
                    }

                    return reject(error);
                }.bind(this));

                resolve(this.initialized);
            }.bind(this));
        }

        _connectEventuallyUntilTimeout(factory, timeout) {
            return new Promise((resolve, reject) => {
                let lastKnownError,
                    isResolved = false;

                setTimeout(() => {
                    if (!isResolved) {
                        isResolved = true;
                        reject(lastKnownError);
                    }
                }, timeout);

                function tryConnect() {
                    const tryConnectAfterTimeout = (error) => {
                            if (isResolved) {
                                return;
                            }

                            if (typeof (error) === "boolean") {
                                error = new Error("Socket closed due to error");
                            }

                            lastKnownError = error;
                            setTimeout(tryConnect, 10000);
                        },
                        socket = factory();

                    socket.once("data", (data) => {
                        socket.removeListener("close", tryConnectAfterTimeout);
                        socket.removeListener("error", tryConnectAfterTimeout);
                        isResolved = true;
                        resolve({ socket, data });
                    });
                    socket.on("close", tryConnectAfterTimeout);
                    socket.on("error", tryConnectAfterTimeout);
                }

                tryConnect();
            });
        }

        _handleData(socketId, data) {
            const reportType = data.readUInt8(),
                infoBuffer = data.slice(Buffer.byteLength(reportType), data.length);

            if (reportType === ERROR_REPORT) {
                const errorMessage = infoBuffer.toString();
                this._handleSocketError(socketId, errorMessage);
            } else if (reportType === OPERATION_END_REPORT) {
                this._handleSyncEnd(infoBuffer);
            }
        }

        _handleSyncEnd(data) {
            const operationUid = data.toString(),
                promiseHandler = this.operationPromises.get(operationUid);

            if (promiseHandler) {
                promiseHandler.resolve(operationUid);
                this.operationPromises.delete(operationUid);
            }
        }

        _handleSocketClose(socketId, hasError) {
            const errorMessage = "Socket closed from server before operation end.";

            this._handleSocketError(socketId, errorMessage);
        }

        _handleSocketError(socketId, errorMessage) {
            const error = this._getErrorWithMessage(errorMessage);
            if (this.socketConnection && this.socketConnection.uid === socketId) {
                this.end();
                this.socketConnection = null;
                this.socketError = error;
            }

            this.operationPromises.forEach((operationPromise, id, operationPromises) => {
                if (operationPromise.socketId === socketId) {
                    operationPromise.reject(error);
                    operationPromises.delete(id);
                }
            });
        }

        _getErrorWithMessage(errorMessage) {
            const error = new Error(errorMessage);
            error.message = errorMessage;

            return error;
        }

        _failSocketOperationsWithError(socketId, error) {

        }

        _resolveRelativeName(fileName, basePath) {
            let relativeFileName;

            if (basePath) {
                relativeFileName = path.relative(basePath, fileName);
            } else if (this.baseDir) {
                relativeFileName = path.relative(this.baseDir, fileName);
            } else {
                console.log(new Error("You need to pass either \"baseDir\" " +
                 "when you initialize the tool or \"basePath\" as a second argument to this method!"));
            }

            return relativeFileName.split(path.sep).join(path.posix.sep);
        }

        _getFileNameData(fileName, basePath) {
            const relativeFileName = this._resolveRelativeName(fileName, basePath),
                fileNameLengthBytes = Buffer.byteLength(relativeFileName),
                fileNameLengthString = fileNameLengthBytes.toString(),
                fileNameLengthSize = Buffer.byteLength(fileNameLengthString);

            return {
                relativeFileName,
                fileNameLengthBytes,
                fileNameLengthString,
                fileNameLengthSize,
                fileName
            };
        }
    }

    return LivesyncTool;
}());

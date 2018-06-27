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
        DELETE_FILE_OPERATION = 7,
        CREATE_FILE_OPERATION = 8,
        DO_SYNC_OPERATION = 9;

    class LivesyncTool {
        constructor() {
            this.initialized = false;
            this.operationPromises = [];
        }

        connect(configurations) {
            this.configurations = configurations;
            this.initialized = false;
            this.configurations.port = this.configurations.port || DEFAULT_PORT;
            this.configurations.localHostAddress = this.configurations.localHostAddress || "127.0.0.1";

            if (!configurations.fullApplicationName) {
                throw new Error(`You need to provide "fullApplicationName" as a configuration property!`);
            }

            if (!configurations.baseDir) {
                throw new Error(`You need to provide "baseDir" as a configuration property!`);
            }

            function adbNotInitializedCallback(err) {
                return new Promise((resolve, reject) => {
                    console.log("This tool expects a connected device or emulator!");
                    reject(err);
                });
            }

            return adbInterface
                .init(this.configurations)
                .then(this._initializeSocket.bind(this), adbNotInitializedCallback.bind(this));
        }

        _initializeSocket(result) {
            return this._connectEventuallyUntilTimeout(function () {
                const { port, localHostAddress } = this.configurations,
                    socket = new net.Socket();

                socket.connect(port, localHostAddress);

                return socket;
            }.bind(this), 100000)
                .then(this._handleConnection.bind(this));
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
                this.socketConnection.on("data", this._handleSyncEnd.bind(this));

                resolve(this.initialized);

                this.socketConnection.on("close", this._handleSocketClose.bind(this, socket.uid));

                this.socketConnection.on("close", function (hasError) {
                    let error = new Error("Server socket is closed!");
                    if (this.initialized) {
                        console.log("Server socket closed!");
                    }
                    if (hasError) {
                        error = new Error("Socket had a transmission error");
                        if (this.configurations.errorHandler) {
                            this.configurations.errorHandler(error);
                        }
                    }

                    reject(error);
                });

                this.socketConnection.on("error", function (err) {
                    this.initialized = false;
                    const error = new Error(`Socket Error:\n${err}`);
                    if (this.configurations.errorHandler) {
                        this.configurations.errorHandler(error);
                    }

                    return reject(error);
                }.bind(this));
            }.bind(this));
        }

        _connectEventuallyUntilTimeout(factory, timeout) {
            return new Promise((resolve, reject) => {
                let lastKnownError,
                    isResolved = false;

                setTimeout(function () {
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

                            lastKnownError = error;
                            setTimeout(tryConnect, 10000);
                        },
                        socket = factory();

                    socket.once("data", (data) => {
                        socket.removeListener("close", tryConnectAfterTimeout);
                        isResolved = true;
                        resolve({ socket, data });
                    });
                    socket.on("close", tryConnectAfterTimeout);
                }

                tryConnect();
            });
        }

        sendFile(fileName, basePath) {
            return new Promise(function (resolve, reject) {
                //TODO throw error if fileContentLengthSizeSize or fileNameLengthSizeSize exceed 1 byte
                const fileNameData = this._getFileNameData(fileName, basePath),
                    stats = fs.statSync(fileName),
                    fileContentLengthBytes = stats.size,
                    fileContentLengthString = fileContentLengthBytes.toString(),
                    fileContentLengthSize = Buffer.byteLength(fileContentLengthString),
                    fileContentLengthSizeSize = Buffer.byteLength(fileContentLengthSize),
                    fileStream = fs.createReadStream(fileName),
                    fileHash = crypto.createHash("md5"),
                    headerBuffer = Buffer.alloc(PROTOCOL_OPERATION_LENGTH_SIZE +
                        fileNameData.fileNameLengthSizeSize +
                        fileNameData.fileNameLengthSize +
                        fileNameData.fileNameLengthBytes +
                        fileContentLengthSizeSize +
                        fileContentLengthSize);
                //console.log(fileName);
                //console.log(fileNameData.relativeFileName);
                let offset = 0;
                offset += headerBuffer.write(CREATE_FILE_OPERATION.toString(), offset, PROTOCOL_OPERATION_LENGTH_SIZE);
                offset = headerBuffer.writeInt8(fileNameData.fileNameLengthSize, offset);
                offset += headerBuffer.write(fileNameData.fileNameLengthString, offset, fileNameData.fileNameLengthSize);
                offset += headerBuffer.write(fileNameData.relativeFileName, offset, fileNameData.fileNameLengthBytes);
                offset = headerBuffer.writeInt8(fileContentLengthSize, offset);
                offset += headerBuffer.write(fileContentLengthString, offset, fileContentLengthSize);
                const hash = crypto.createHash("md5").update(headerBuffer).digest();

                //console.log(`starting ${fileName}`);
                function writeDone(err) {
                    //TODO: meditate on this
                    // if(err) {
                    //     reject(err)
                    // }
                    //console.log(`done ${fileName}`);
                    resolve(true);
                }
                this.socketConnection.write(headerBuffer);
                this.socketConnection.write(hash);
                fileStream.on("data", (chunk) => {
                    fileHash.update(chunk);
                    //console.log(`writing ${fileName}`);
                    this.socketConnection.write(chunk);
                }).on("end", () => {
                    //console.log(`hash ${fileName}`);
                    this.socketConnection.write(fileHash.digest(), writeDone);
                }).on("error", (error) => {
                    //console.log("error");
                });
                //TODO onerror
            }.bind(this));
        }

        deleteFile(fileName, basePath) {
            return new Promise(function (resolve, reject) {
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

                function writeDone() {
                    resolve(true);
                }

                this.socketConnection.write(headerBuffer);
                this.socketConnection.write(hash, writeDone);
            }.bind(this));
        }

        sendDirectory(dir) {
            return new Promise(function (resolve, reject) {
                recursive(dir, function (err, list) {
                    this.sendFilesArray.call(this, list).then(() => {
                        resolve(list);
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

        sendDoSyncOperation() {
            const id = crypto.randomBytes(16).toString("hex"),
                operationPromise = new Promise(function (resolve, reject) {
                    const message = `${DO_SYNC_OPERATION}${id}`,
                        socketId = this.socketConnection.uid,
                        hash = crypto.createHash("md5").update(message).digest();

                    this.operationPromises[id] = {
                        resolve,
                        reject,
                        socketId
                    };

                    this.socketConnection.write(message);
                    this.socketConnection.write(hash);
                }.bind(this));

            return operationPromise;
        }

        end() {
            this.socketConnection.end();
        }

        _handleSyncEnd(data) {
            const operationUid = data.toString(),
                promiseHandler = this.operationPromises[operationUid];

            if (promiseHandler) {
                promiseHandler.resolve(operationUid);
                delete this.operationPromises[operationUid];
            }
        }

        _handleSocketClose(hasError, socketId) {
            this.operationPromises.forEach((id, operationPromise) => {
                if (operationPromise.socketId === socketId) {
                    operationPromise.reject(hasError);
                    delete this.operationPromises[id];
                }
            });
        }

        _resolveRelativeName(fileName, basePath) {
            let relativeFileName;

            if (basePath) {
                relativeFileName = path.relative(basePath, fileName);
            } else if (this.baseDir) {
                relativeFileName = path.relative(this.baseDir, fileName);
            } else {
                console.log(new Error("You need to pass either \"baseDir\" when you initialize the tool or \"basePath\" as a second argument to this method!"));
            }

            return relativeFileName.split(path.sep).join(path.posix.sep);
        }

        _getFileNameData(filename, basePath) {
            const relativeFileName = this._resolveRelativeName(filename, basePath),
                fileNameLengthBytes = Buffer.byteLength(relativeFileName),
                fileNameLengthString = fileNameLengthBytes.toString(),
                fileNameLengthSize = Buffer.byteLength(fileNameLengthString),
                fileNameLengthSizeSize = Buffer.byteLength(fileNameLengthSize);

            return {
                relativeFileName,
                fileNameLengthBytes,
                fileNameLengthString,
                fileNameLengthSize,
                fileNameLengthSizeSize
            };
        }
    }

    return LivesyncTool;
}());

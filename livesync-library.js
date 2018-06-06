let net = require('net'),
    fs = require('fs'),
    path = require('path'),
    adbInterface = require('./adb-interface.js'),
    crypto = require('crypto');

module.exports = (function () {
    let socketConnection,
        serverIsReadyToListen = false,
        baseDir

    const DEFAULT_PORT = 18182,
        PROTOCOL_VERSION_LENGTH_SIZE = 1,
        PROTOCOL_OPERATION_LENGTH_SIZE = 1,
        HASH_SIZE = 16,
        DELETE_FILE_OPERATION = 7,
        CREATE_FILE_OPERATION = 8,
        DO_SYNC_OPERATION = 9

    function init(configurations) {
        if (!configurations.fullApplicationName) {
            throw new Error(`You need to provide "fullApplicationName" as a configuration property!`)
        }
        if (!configurations.baseDir) {
            throw new Error(`You need to provide "baseDir" as a configuration property!`)
        }

        let localHostPort = configurations.port ? configurations.port : DEFAULT_PORT,
            localHostAddress = configurations.address ? configurations.address : '127.0.0.1',
            adbForwardSuffix = configurations.adbForwardSuffix ? configurations.adbForwardSuffix : '',
            fullApplicationName = configurations.fullApplicationName,
            socket = new net.Socket()

        baseDir = configurations.baseDir

        return adbInterface
            .init(configurations)
            .then(adbInitializedCallback, adbNotInitializedCallback)

        function adbInitializedCallback(data) {
            return new Promise(function (resolve, reject) {
                socketConnection = socket.connect(localHostPort, localHostAddress)

                socketConnection.on('data', function (data) {
                    var versionLength = data.readUInt8(),
                    versionBuffer = data.slice(PROTOCOL_VERSION_LENGTH_SIZE, versionLength + PROTOCOL_VERSION_LENGTH_SIZE),
                    applicationIdentifierBuffer = data.slice(versionLength + PROTOCOL_VERSION_LENGTH_SIZE, data.length),
                    version = versionBuffer.toString();
                    applicationIdentifier = applicationIdentifierBuffer.toString();

                    serverIsReadyToListen = true
                    return resolve(serverIsReadyToListen)
                })

                socketConnection.on('close', function (had_error) {
                    let error = new Error('Server socket is closed!')
                    if (serverIsReadyToListen) {
                        console.log('Server socket closed!')
                    }
                    if (had_error) {
                        error = new Error('Socket had a transmission error')
                        if (configurations.errorHandler) {
                            configurations.errorHandler(error)
                        }
                    }
                    return reject(false)
                })

                socketConnection.on('error', function (err) {
                    serverIsReadyToListen = false
                    let error = new Error(`Socket Error:\n${err}`)
                    if (configurations.errorHandler) {
                        configurations.errorHandler(error)
                    }
                    return reject(false)
                })
            })
        }

        function adbNotInitializedCallback(err) {
            return new Promise(function (resolve, reject) {
                console.log('This tool expects a connected device or emulator!')
                reject(err)
            })
        }
    }

    function sendFile(fileName, basePath) {
        return new Promise(function (resolve, reject) {
            //TODO throw error if fileContentLengthSizeSize or fileNameLengthSizeSize exceed 1 byte
            var offset = 0,
                fileNameData = _getFileNameData(fileName, basePath);
                stats = fs.statSync(fileName),
                fileContentLengthBytes = stats.size,
                fileContentLengthString = fileContentLengthBytes.toString(),
                fileContentLengthSize = Buffer.byteLength(fileContentLengthString),
                fileContentLengthSizeSize = Buffer.byteLength(fileContentLengthSize),
                fileStream = fs.createReadStream(fileName),
                fileHash = crypto.createHash('md5'),
                headerBuffer = new Buffer(
                    PROTOCOL_OPERATION_LENGTH_SIZE +
                    fileNameData.fileNameLengthSizeSize +
                    fileNameData.fileNameLengthSize +
                    fileNameData.fileNameLengthBytes +
                    fileContentLengthSizeSize +
                    fileContentLengthSize
                );

            offset += headerBuffer.write(CREATE_FILE_OPERATION.toString(), offset, PROTOCOL_OPERATION_LENGTH_SIZE);
            offset = headerBuffer.writeInt8(fileNameData.fileNameLengthSize, offset);
            offset += headerBuffer.write(fileNameData.fileNameLengthString, offset, fileNameData.fileNameLengthSize);
            offset += headerBuffer.write(fileNameData.relativeFileName, offset, fileNameData.fileNameLengthBytes);
            offset = headerBuffer.writeInt8(fileContentLengthSize, offset);
            offset += headerBuffer.write(fileContentLengthString, offset, fileContentLengthBytes);
            hash = crypto.createHash('md5').update(headerBuffer).digest();

            console.log(`starting ${fileName}`);
            function writeDone(err) {
                //TODO: meditate on this
                // if(err) {
                //     reject(err)
                // }
                console.log(`done ${fileName}`);
                resolve(true)
            }
            socketConnection.write(headerBuffer);
            socketConnection.write(hash);
            fileStream.on("data", (chunk) => {
                fileHash.update(chunk);
                console.log(`writing ${fileName}`);
                socketConnection.write(chunk);
            }).on("end", () => {
                console.log(`hash ${fileName}`);
                socketConnection.write(fileHash.digest(), writeDone);
            })
            //TODO onerror
        })
    }

    function deleteFile(fileName, basePath) {
        return new Promise(function (resolve, reject) {
            var offset = 0,
                fileNameData = _getFileNameData(fileName, basePath),
                headerBuffer = new Buffer(
                    PROTOCOL_OPERATION_LENGTH_SIZE +
                    fileNameData.fileNameLengthSizeSize +
                    fileNameData.fileNameLengthSize +
                    fileNameData.fileNameLengthBytes
                );

            offset += headerBuffer.write(DELETE_FILE_OPERATION.toString(), offset, PROTOCOL_OPERATION_LENGTH_SIZE);
            offset = headerBuffer.writeInt8(fileNameData.fileNameLengthSize, offset);
            offset += headerBuffer.write(fileNameData.fileNameLengthString, offset, fileNameData.fileNameLengthSize);
            headerBuffer.write(fileNameData.relativeFileName, offset, fileNameData.fileNameLengthBytes);
            var hash = crypto.createHash('md5').update(headerBuffer).digest()

            function writeDone() {
                resolve(true)
            }

            socketConnection.write(headerBuffer)
            socketConnection.write(hash, writeDone)
        })
    }

    function sendDirectory(dir) {
        return new Promise(function (resolve, reject) {
            _traverseDir(dir, function (err, list) {
                if (err) {
                    reject(err)
                }
                resolve(list)
            })
        })
    }

    function sendFilesArray(filesArr) {
        var reducer = function(promise, file) {
            if (!fs.lstatSync(file).isDirectory()) {
                if (!fs.existsSync(file)) {
                    console.log(`${file} doesn't exist.\nThis tool works only with absolute paths!`)
                }

                return promise.then(function(){
                    return sendFile.call(this, file);
                });
            }

            return promise;
        }

        return filesArr.reduce(reducer, Promise.resolve());
    }

    function removeFilesArray(filesArr) {
        let removeFilesPromises = []
        filesArr.forEach(file => {
            removeFilesPromises.push(deleteFile(file))
        })
        return Promise.all(removeFilesPromises)
    }

    function sendDoSyncOperation() {
        return new Promise(function (resolve, reject) {
            var message = `${DO_SYNC_OPERATION}`,
                hash = crypto.createHash('md5').update(`${DO_SYNC_OPERATION}`).digest();

            function writeDone() {
                resolve(true)
            }

            socketConnection.write(message);
            socketConnection.write(hash, writeDone);
        })
    }

    function end() {
        socketConnection.end()
    }

    function __resolveRelativeName(fileName, basePath) {
        var relativeFileName

        if (basePath) {
            relativeFileName = path.relative(basePath, fileName)
        } else {
            if (baseDir) {
                relativeFileName = path.relative(baseDir, fileName)
            } else {
                console.log(new Error('You need to pass either "baseDir" when you initialize the tool or "basePath" as a second argument to this method!'))
            }
        }

        return relativeFileName
    }

    function _getFileNameData(filename, basePath) {
        relativeFileName = __resolveRelativeName(filename, basePath),
        fileNameLengthBytes = Buffer.byteLength(relativeFileName),
        fileNameLengthString = fileNameLengthBytes.toString(),
        fileNameLengthSize = Buffer.byteLength(fileNameLengthString),
        fileNameLengthSizeSize = Buffer.byteLength(fileNameLengthSize);

        return {relativeFileName, fileNameLengthBytes, fileNameLengthString, fileNameLengthSize, fileNameLengthSizeSize};
    }

    function _traverseDir(dir, done) {
        var results = []
        fs.readdir(dir, function (err, list) {
            if (err) {
                return done(err)
            }
            var remaining = list.length
            if (!remaining) {
                return done(null, results)
            }
            list.forEach(function (file) {
                file = path.resolve(dir, file)
                fs.stat(file, function (err, stat) {
                    if (stat && stat.isDirectory()) {
                        _traverseDir(file, function (err, res) {
                            results = results.concat(res)
                            if (!--remaining) {
                                if (done instanceof Function) {
                                    done(null, results)
                                }
                            }
                        })
                    } else {
                        results.push(file)
                        sendFile(file)
                        if (!--remaining) {
                            done(null, results)
                        }
                    }
                })
            })
        })
    }

    return {
        init: init,
        sendFile: sendFile,
        deleteFile: deleteFile,
        sendDirectory: sendDirectory,
        sendFilesArray: sendFilesArray,
        removeFilesArray: removeFilesArray,
        sendDoSyncOperation, sendDoSyncOperation,
        end: end
    }
})()
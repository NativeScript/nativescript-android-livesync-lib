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
        DELETE_FILE_OPERATION = 7,
        CREATE_FILE_OPERATION = 8,
        DO_SYNC_OPERATION = 9

    function init(configurations) {
        if (!configurations.fullApplicationName) {
            throw new Error(`You need to provide "fullApplicationName" as a configuration propery!`)
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
            var relativeFileName = __resolveRelativeName(fileName, basePath)

            var fileNameLength = _getSanatizedStringLength(relativeFileName, 5),
                stats = fs.statSync(fileName),
                fileContentLength = _getSanatizedStringLength(stats.size, 10),
                fileStream = fs.createReadStream(fileName),
                header = `${CREATE_FILE_OPERATION}${fileNameLength}${relativeFileName}${fileContentLength}`,
                hash = crypto.createHash('md5').update(header).digest(),
                fileHash = crypto.createHash('md5');

            function writeDone(err) {
                //TODO: plamen5kov: meditate on this
                // if(err) {
                //     reject(err)
                // }
                resolve(true)
            }
            socketConnection.write(header)
            socketConnection.write(hash);
            fileStream.on("data", (chunk) => {
                fileHash.update(chunk);
                socketConnection.write(chunk);
            }).on("end", () => {
                socketConnection.write(fileHash.digest(), writeDone);
            })
        })
    }

    function deleteFile(fileName, basePath) {
        return new Promise(function (resolve, reject) {
            var relativeFileName = __resolveRelativeName(fileName, basePath)
            var fileNameLength = _getSanatizedStringLength(relativeFileName, 5)
            var header = `${DELETE_FILE_OPERATION}${fileNameLength}${relativeFileName}`;
            var hash = crypto.createHash('md5').update(header).digest()

            function writeDone() {
                resolve(true)
            }

            socketConnection.write(header)
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
        let sendFilePromises = []
        filesArr.forEach(file => {
            if (!fs.lstatSync(file).isDirectory()) {
                if (!fs.existsSync(file)) {
                    console.log(`${file} doesn't exist.\nThis tool works only with absolute paths!`)
                }
                sendFilePromises.push(sendFile(file))
            }
        })
        return Promise.all(sendFilePromises)
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

    function _getSanatizedStringLength(input, biteLength) {
        var arr = new Array(biteLength)
        var initialString = arr.join('0')
        size = input.length ? input.length : input;
        return (initialString + size).substr(-biteLength)
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
let path = require('path')
let adbExecutablePath = path.resolve(__dirname, './adb/adb'),
    exec = require('child_process').exec
module.exports = (function () {

    function list() {
        return new Promise(function (resolve, reject) {
            exec(`${adbExecutablePath} forward --list`, function (stderr, stdout) {
                if (stderr) {
                    reject(stderr)
                }
                if (stdout) {
                    resolve(stdout)
                }
            })
        })
    }

    function init(configurations) {
        
        let fullApplicationName = configurations.fullApplicationName,
        deviceIdentifier = configurations.deviceIdentifier ? `-s ${configurations.deviceIdentifier}` : '',
            port = configurations.port,
            suffix = configurations.suffix

        return new Promise(function (resolve, reject) {
            if (!suffix) {
                suffix = 'livesync'
            }
            exec(`${adbExecutablePath} ${deviceIdentifier} forward tcp:${port} localabstract:${fullApplicationName}-${suffix}`, function (stderr, stdout) {
                if (stderr) {
                    reject(new Error(`ADB Error:\n${stderr}`))
                }

                resolve(true)
            })
        })
    }

    return {
        list: list,
        init: init,
    }
})()
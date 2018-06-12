const path = require("path"),
    adbExecutablePath = path.resolve(__dirname, "./adb/adb"),
    { exec } = require("child_process");

module.exports = (function () {
    function list() {
        return new Promise(function (resolve, reject) {
            exec(`${adbExecutablePath} forward --list`, function (stderr, stdout) {
                if (stderr) {
                    reject(stderr);
                }
                if (stdout) {
                    resolve(stdout);
                }
            });
        });
    }

    function init(configurations) {
        const { fullApplicationName, port } = configurations,
            deviceIdentifier = configurations.deviceIdentifier ? `-s ${configurations.deviceIdentifier}` : "";

        let { suffix } = configurations;

        return new Promise(function (resolve, reject) {
            if (!suffix) {
                suffix = "livesync";
            }
            exec(`adb ${deviceIdentifier} forward tcp:${port} localabstract:${fullApplicationName}-${suffix}`, function (stderr, stdout) {
                if (stderr) {
                    reject(new Error(`ADB Error:\n${stderr}`));
                }

                resolve(true);
            });
        });
    }

    return {
        list,
        init
    };
}());

# nativescript-android-livesync-lib
JavaScript library for livesyncing changes to a NativeScript application on android.

## System requirements
In order to use this package you need:
 - NativeScript Anrdroid Runtime 4.2.0 or later
 - Node.js 4.0.0 or later
 - npm 2.0.0 or later added to your PATH environment variable (you should be able to execute `npm --version` from your default terminal).

## Usage
The library has a few public methods that allow file manipulation to the files of a NativeScript application and provide control for refreshing the application. Restarting the application if necessary should be done by the user of this library.

### Calling init
Init method will establish a fresh socket connection with the application. It takes a configuration object as parameter.
config

Example:
```
livesyncTool = require("nativescript-android-livesync-lib");

/**
 * address defaults to "127.0.0.1".
 * port defaults to "18182".
 */
var configuration = {
	baseDir: /c/myprojects/myapp/app/,
	fullApplicationName: "com.tns.myapp",
	deviceIdentifier: "aaaaaaaa"
	address: '127.0.0.2'
	port: 18183
}

livesyncTool.init(configuration)
```

The method returns a promise which is resolved once the connection is established.

### Calling sendFile
Send file will create/update the file with the file content it reads from the filePath that is provided. It will compute the relative path based on the base path provided as argument or the one provided in the `init` method.

Example:
```
livesyncTool.sendFile("/c/myprojects/myapp/app/index.js", "/c/myprojects/myapp/app/");
livesyncTool.sendFile("/c/myprojects/myapp/app/index.js");
```


### Calling deleteFile
When called, deleteFile will compute the relative path based on the base path provided as argument or the one provided in the `init` method and delete the corresponding file/directory on the device.

Example:
```
livesyncTool.sendFile("/c/myprojects/myapp/app/index.js", "/c/myprojects/myapp/app/");
livesyncTool.sendFile("/c/myprojects/myapp/app/index.js");
```

## Protocol:

|Operation Name | Operation | File Name Length Size | File Name Length | File Name |  File Content Length Size | Header Hash | File Content Length | File Content | File hash |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| runSync: | 9 | | | | | | md5 hash | | |
| create: | 8 | 1 | 7 | ./a.txt | 1 | 11 | md5 hash | fileContent | md5 hash |
| delete: | 7 | 1 | 3 | ./a | | | md5 hash | | |

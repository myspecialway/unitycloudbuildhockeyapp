// Initialise .env config.
require('dotenv').config();

// Options
const options = {
    port: process.env.PORT || 3000,
    unityAPIBase: "https://build-api.cloud.unity3d.com", // URI (e.g. href) recieved in web hook payload.
    unityCloudAPIKey: process.env.UNITYCLOUD_KEY,
    hockeyappId: process.env.HOCKEYAPPID,
    hockeyappAPIKey: process.env.HOCKEYAPP_KEY,
    authorizationKey: process.env.AUTH_KEY,
    projectGuid: process.env.PROJECT_GUID
};

// Imports
const path = require('path'),
    fs = require('fs'),
    https = require('https'),
    express = require('express'),
    app = express(),
    request = require('request'),
    FormData = require('form-data'),
    url = require("url");

app.use(express.json());

// Run Server
app.listen( options.port, function(){
  console.log('listening on *:' + options.port );
});

app.post('/build', function (req, res) {
    if (!req.body) return res.sendStatus(400);

    if(!isValidRequest(req)) return res.sendStatus(401);

    // 1. Get Build API URL
    const buildAPIURL = req.body.links.api_self.href;
    if( !buildAPIURL ) {
        // URL not available.
        res.setHeader('Content-Type', 'application/json');
        res.send({
            error: true,
            message: "No build link from Unity Cloud Build webhook"
        });
    } else {
        // URL available.
        res.setHeader('Content-Type', 'application/json');
        res.send({
            error: false,
            message: "Process begun for project '" + req.body.projectName + "' platform '" + req.body.buildTargetName + "'."
        });

        // 2. Grab binary URL from Unity Cloud API
        getBuildDetails( buildAPIURL );
    }
});

function isValidRequest(req){

    let authHeader = req.header("Authorization");
    if(authHeader !== options.authorizationKey) {
        console.log(`Invalid header - ${authHeader}`);
        return false;
    }

    if(req.body.projectGuid !== options.projectGuid){
        console.log(`Invalid project guid - ${req.body.projectGuid}`);
        return false;
    }

    if(req.body.buildStatus !== 'success'){
        console.log(`Invalid buildStatus - ${req.body.buildStatus}`);
        return false;
    }

    return true;
}

function getBuildDetails( buildAPIURL ){
    console.log("1. getBuildDetails: start");

    const requestOptions = {
        headers: {
            'Authorization': `Basic ${options.unityCloudAPIKey}`,
            'Content-Type': 'application/json'
        }
    };

    request.get(options.unityAPIBase + buildAPIURL, requestOptions, function(error, response, body){

            if(error) {
                console.log(error);
            }
            else if(response.statusCode !== 200) {
                console.log(`Failed getting details with status - ${response.statusCode}`);
            }
            else {
                const data = JSON.parse(body);

                const parsed = url.parse(data.links.download_primary.href);
                const filename = path.basename(parsed.pathname);

                console.log("1. getBuildDetails: finished");

                // 3. Download binary.
                downloadBinary(data.links.download_primary.href, filename);
            }
        }
    );
}

function downloadBinary( binaryURL, filename ){
    
    console.log("2. downloadBinary: start");
    console.log("   " + binaryURL);
    console.log("   " + filename);

    deleteFile( filename );

    https.get( binaryURL, (res) => {

        if(res.statusCode !== 200){
            return console.log(`Failed to download with status - ${res.statusCode}`);
        }

        const writeStream = fs.createWriteStream(filename, {'flags': 'a'});

        const len = parseInt(res.headers["content-length"], 10);
        let cur = 0;
        const total = len / 1048576; //1048576 - bytes in  1Megabyte

        res.on('data', (chunk) => {

            cur += chunk.length;
            writeStream.write(chunk, 'binary');

            console.log("Downloading " + (100.0 * cur / len).toFixed(2) + "%, Downloaded: " + (cur / 1048576).toFixed(2) + " mb, Total: " + total.toFixed(2) + " mb");
        });

        res.on('end', () => {

            console.log("2. downloadBinary: finished");
            writeStream.end();

        });

        writeStream.on('finish', () => {

            uploadToHockeyApp( filename );
        });

    }).on('error', (e) => {
      console.error(e);
    });
}

function uploadToHockeyApp( filename ){
    console.log("3. uploadToHockeyApp: start");

    const readable = fs.createReadStream(filename);
    readable.on('error', () => {
        console.log('Error reading binary file for upload to HockeyApp');
    });

    // HockeyApp properties
    const HOCKEY_APP_HOST = 'rink.hockeyapp.net';
    const HOCKEY_APP_PATH = `/api/2/apps/${options.hockeyappId}/app_versions`;
    const HOCKEY_APP_PROTOCOL = 'https:';

    // Create FormData
    const form = new FormData();
    form.append('status', 2);
    form.append('notes', "Automated release triggered from Unity Cloud Build.");
    form.append('notes_type', 0);
    form.append('notify', 0);
    form.append('ipa', readable);

    const req = form.submit({
        host: HOCKEY_APP_HOST,
        path: HOCKEY_APP_PATH,
        protocol: HOCKEY_APP_PROTOCOL,
        headers: {
            'Accept': 'application/json',
            'X-HockeyAppToken': options.hockeyappAPIKey
        }
    }, function (err, res) {
        if (err) {
            console.log(err);
            return;
        }

        if (res.statusCode !== 200 && res.statusCode !== 201) {
            console.log('Uploading failed with status ' + res.statusCode);
            console.log(res.statusMessage);
            return;
        }

        let jsonString = '';
        res.on('data', (chunk) => {

            jsonString += String.fromCharCode.apply(null, new Uint16Array(chunk));

        });

        res.on('end', () => {

            console.log("3. uploadToHockeyApp: finished");

            deleteFile(filename);

        });
    });

    // Track upload progress.
    const len = parseInt(req.getHeader('content-length'), 10);
    let cur = 0;
    const total = len / 1048576; //1048576 - bytes in  1Megabyte

    req.on('data', (chunk) => {
        cur += chunk.length;
        console.log("Downloading " + (100.0 * cur / len).toFixed(2) + "%, Downloaded: " + (cur / 1048576).toFixed(2) + " mb, Total: " + total.toFixed(2) + " mb");
    });

}

// Delete file, used to clear up any binary downloaded.
function deleteFile( filename ){
    fs.exists(filename, function(exists) { 
      if (exists) { 
        // Delete File.
        fs.unlink( filename );
      } 
    }); 
}
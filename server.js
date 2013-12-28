var express = require('express'),
    dgram = require('dgram'),
    fs = require('fs'),
    util = require('util'),
    ytdl = require('ytdl'),
    path = require('path'),
    slugs = require('slugs'),
    exec = require('child_process').exec,
    clim = require("clim");


var console = clim();
var config, tmpConfig;
try {
    tmpConfig = fs.readFileSync(__dirname + '/config.json');
} catch (err) {
    throw new Error('No config.json present.');
}

try {
    config = JSON.parse(tmpConfig);
} catch (err) {
    throw new Error('Config file does not seem to be valid JSON.');
}

var BASE_PATH = config.basePath;

var playlist = [];
var tracks = [];
var isPlaying = 0;
var currentlyPlaying = -1;
var skipNotification = false;
var in_destination_dir = false;

// Prepare webserver
var app = express();

app.configure(function() {
    app.use(express.bodyParser());
    app.use(express.methodOverride());
});

app.set('port', process.env.PORT || 8080);
app.listen(app.get('port'));

app.use(express.basicAuth(function(user, pass, fn) {
    if (config.users && config.users[user] && config.users[user].password && config.users[user].password == pass && config.users[user].permissions) {
        fn(null, config.users[user]);
    } else {
        fn(new Error('Unauthenticated.'));
    }
}));
app.use(express.static(__dirname + '/public'));

app.get('/api/tracks', function(req, res) {
    if (!req.user.permissions.view) {
        res.send(403, 'Not allowed.');
        return;
    }
    res.setHeader('Content-Type', 'application/json');
    var result = [];
    tracks.forEach(function(track, id) {
        result.push({
            id: id,
            name: track.name
        });
    });
    res.end(JSON.stringify(result));
});

app.get('/api/playing', function(req, res) {
    if (!req.user.permissions.view) {
        res.send(403, 'Not allowed.');
        return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (isPlaying) {
        res.end(JSON.stringify({
            id: currentlyPlaying,
            name: tracks[currentlyPlaying].name
        }));
    } else {
        res.end(JSON.stringify(false));
    }
});

app.get('/api/playlist', function(req, res) {
    if (!req.user.permissions.view) {
        res.send(403, 'Not allowed.');
        return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(playlist));
});

app.post('/api/refresh', function(req, res) {
    if (!req.user.permissions.refresh) {
        res.send(403, 'Not allowed.');
        return;
    }
    // /stop will not emit a notification
    console.log('Refreshing folder');
    tracks = [];
    readDir();
    res.end();
});

app.post('/api/stop', function(req, res) {
    if (!req.user.permissions.stop) {
        res.send(403, 'Not allowed.');
        return;
    }
    // /stop will not emit a notification
    console.log('Stopping');
    skipNotification = false;
    isPlaying = false;
    var cmd = new Buffer("/stop");
    cmdSocket.send(cmd, 0, cmd.length, 19111, '127.0.0.1');
    res.end();
});

// Plays next song in playlist
app.post('/api/next', function(req, res) {
    if (playlist.length > 0) {
        // /stop will not emit a notification
        console.log('Stopping');
        skipNotification = false;
        isPlaying = false;
        var cmd = new Buffer("/stop");
        cmdSocket.send(cmd, 0, cmd.length, 19111, '127.0.0.1');

        var track = playlist.shift();
        playById(track.id);
        isPlaying = true;
        currentlyPlaying = track.id;
    }
    res.end();
});

app.post('/api/play/:id', function(req, res) {
    if (!req.user.permissions.queue) {
        res.send(403, 'Not allowed.');
        return;
    }
    console.log('Playing: ' + req.params.id);
    playById(req.params.id);
    res.end();
});

app.post('/api/playDirect/:id', function(req, res) {
    if (!req.user.permissions.play) {
        res.send(403, 'Not allowed.');
        return;
    }
    console.log('Playing: ' + req.params.id);
    playById(req.params.id, true);
    res.end();
});

app.post('/api/unqueue/:id', function(req, res) {
    if (!req.user.permissions.unqueue) {
        res.send(403, 'Not allowed.');
        return;
    }
    console.log('Removing: ' + req.params.id);
    // playById(req.params.id);
    var id = parseInt(req.params.id, 10);
    if (playlist.length <= id) {
        res.end(JSON.stringify(false));
        return;
    }
    playlist.splice(id, 1);
    res.end(JSON.stringify(true));
});

// Clear current playlist
app.post('/api/clear', function(req, res) {
    playlist = [];
    res.end();
});

app.post('/file/upload', function(req, res) {
    if (typeof req.files != "undefined") {
        var temp_path   = req.files.uploadfile.path;
        var fileName    = req.files.uploadfile.name;

        console.log("got file upload: " + fileName);
console.log(req.body.filename);
        if (typeof req.body.filename != "undefined" && req.body.filename != "") {
            console.log("File name (custom): " + fileName);
            fileName = req.body.filename;
        }

        fileName = fileName.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue');
        fileName = fileName.replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue');
        fileName = fileName.replace(/ß/g, 'ss').replace(/\//g, '-');

        var save_path = BASE_PATH + '/' + fileName;

        var is = fs.createReadStream(temp_path)
        var os = fs.createWriteStream(save_path);

        is.pipe(os, function() {
            fs.unlinkSync(temp_path);
        });

        res.end(JSON.stringify(true));
    } else if (req.body.youtube != "") {
        // code used from: https://github.com/drowzyorginal/node-ytmp3/
        console.log("got youtube video: " + req.body.youtube)

        var ytUrl = req.body.youtube;
        var myytld = ytdl(ytUrl);

        ytdl.getInfo(ytUrl, function(err, info) {
            var videoTitle = info.title;

            console.log("Video title: " + videoTitle);

            if (typeof req.body.filename != "undefined" && req.body.filename != "") {
                console.log("Video title (custom): " + videoTitle);
                videoTitle = req.body.filename;
            } else {
                videoTitle = slugs(videoTitle);
            }

            videoTitle = videoTitle.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue');
            videoTitle = videoTitle.replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue');
            videoTitle = videoTitle.replace(/ß/g, 'ss').replace(/\//g, '-');

            var destination = path.normalize(BASE_PATH + "/../yttmp/") + videoTitle + ".flv";
            var vidstream   = fs.createWriteStream(destination);
            myytld.pipe(vidstream);

            vidstream.on('close', function() {
                console.log("Download complete");

                if (!in_destination_dir) {
                    try {
                        in_destination_dir = true;
                        process.chdir(BASE_PATH);
                    } catch (err) {
                        throw err;
                    }
                }

                res.setHeader('Content-Type', 'application/json');

                var destination_file = destination.split('/').slice(-1)[0].replace('.flv', '.mp3');
                var ffmpeg = 'avconv -y -i ' + '"' + destination + '"' + ' ' + '"' + destination_file + '"';

                var child = exec(ffmpeg, function(err, stdout, stderr) {
                    if (err) {
                        //throw err;
                        console.log(err);
                        res.end(JSON.stringify(false));
                    } else {
                        console.log(destination.split('/').slice(-1)[0] + ' converted to ' + destination_file);
                        fs.unlinkSync(destination);
                        res.end(JSON.stringify(true));
                    }
                });
            });
        });
    }
});

// Prepare UDP socket
var cmdSocket = dgram.createSocket('udp4');
var recSocket = dgram.createSocket('udp4');

recSocket.bind(19112);
recSocket.on('message', function(msg) {
    console.log('Got notification from plugin.');
    if (playlist.length > 0 && !skipNotification) {
        console.log('Playing next song.');
        isPlaying = false;
        var track = playlist.shift();
        playById(track.id);
        isPlaying = true;
        currentlyPlaying = track.id;
    } else
    if (!skipNotification) {
        isPlaying = false;
    }
    skipNotification = false;
});

readDir();

// Get all files in that directory
function readDir() {
    fs.readdir(BASE_PATH, function(err, files) {
        if (err) {
            throw new Error('Could not find files in basePath. Aborting.');
        }

        files.forEach(function(file) {
            tracks.push({
                file: BASE_PATH + '/' + file,
                name: file
            });
        });
    });
}

// Helper functions
var playById = function(id, direct) {
    if (tracks.length <= id) {
        console.log('Invalid track.');
        return;
    }
    var track = tracks[id];
    if (isPlaying && !direct) {
        playlist.push({
            id: id,
            name: track.name
        })
    } else {
        if (direct && isPlaying) {
            skipNotification = true;
        }
        isPlaying = true;
        currentlyPlaying = id;
        var cmd = new Buffer("/music " + track.file);
        cmdSocket.send(cmd, 0, cmd.length, 19111, '127.0.0.1');
    }
};

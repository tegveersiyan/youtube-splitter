const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const ytdl = require('ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const { google } = require('googleapis');

// Set FFmpeg paths for Render
const ffmpegPath = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg';
const ffprobePath = process.env.FFPROBE_PATH || '/usr/bin/ffprobe';

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// YouTube API setup
const youtube = google.youtube('v3');
const API_KEY = process.env.YOUTUBE_API_KEY;

if (!API_KEY) {
    console.error('Error: YouTube API key not set. Please set the YOUTUBE_API_KEY environment variable.');
    process.exit(1);
}

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// Create downloads directory if it doesn't exist
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
}

// Debug middleware to log all requests
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server Error:', err);
    res.status(500).json({ 
        error: true,
        message: 'Server error: ' + err.message 
    });
});

// Ensure JSON responses for API endpoints
app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
        res.setHeader('Content-Type', 'application/json');
    }
    next();
});

// Test FFmpeg installation
ffmpeg.getAvailableFormats(function(err, formats) {
    if (err) {
        console.error('FFmpeg Error:', err);
        console.error('Please ensure FFmpeg is installed and accessible at:', ffmpegPath);
        process.exit(1);
    } else {
        console.log('FFmpeg is properly installed and accessible');
    }
});

app.post('/split-video', async (req, res) => {
    console.log('Received split-video request:', req.body);
    
    try {
        const { youtubeUrl, timestamps: rawTimestamps } = req.body;
        
        if (!youtubeUrl || !rawTimestamps || !Array.isArray(rawTimestamps)) {
            console.log('Invalid input:', { youtubeUrl, rawTimestamps });
            return res.status(400).json({ 
                error: true,
                message: 'Invalid input: URL and timestamps are required' 
            });
        }

        let videoId;
        try {
            videoId = ytdl.getVideoID(youtubeUrl);
            console.log('Extracted video ID:', videoId);
        } catch (error) {
            console.error('Error extracting video ID:', error);
            return res.status(400).json({ 
                error: true,
                message: 'Invalid YouTube URL' 
            });
        }

        // Get video info using YouTube API
        let videoInfo;
        try {
            console.log('Fetching video info from YouTube API...');
            videoInfo = await youtube.videos.list({
                key: API_KEY,
                part: 'snippet',
                id: videoId
            });
            console.log('Video info received:', videoInfo.data.items ? 'Video found' : 'Video not found');
        } catch (error) {
            console.error('YouTube API Error:', error);
            return res.status(500).json({ 
                error: true,
                message: 'Failed to fetch video information from YouTube' 
            });
        }

        if (!videoInfo.data.items || videoInfo.data.items.length === 0) {
            console.log('Video not found in YouTube API response');
            return res.status(404).json({ 
                error: true,
                message: 'Video not found' 
            });
        }

        const videoTitle = videoInfo.data.items[0].snippet.title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const videoPath = path.join(downloadsDir, `${videoTitle}.mp3`);
        console.log('Processing video:', videoTitle);

        const parsedTimestamps = rawTimestamps.map(ts => {
            if (typeof ts === 'string' && ts.includes(':')) {
                const parts = ts.split(':').map(Number);
                if (parts.length === 2) return parts[0] * 60 + parts[1];
                if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
            }
            return Number(ts);
        }).filter(ts => !isNaN(ts)).sort((a, b) => a - b);

        console.log('Parsed timestamps:', parsedTimestamps);

        if (parsedTimestamps.length === 0) {
            console.log('No valid timestamps provided');
            return res.status(400).json({ 
                error: true,
                message: 'No valid timestamps provided' 
            });
        }

        if (parsedTimestamps[0] !== 0) {
            parsedTimestamps.unshift(0);
        }

        // Download video using ytdl-core
        try {
            console.log('Starting video download...');
            await new Promise((resolve, reject) => {
                ytdl(youtubeUrl, {
                    quality: 'highestaudio',
                    filter: 'audioonly'
                })
                .pipe(fs.createWriteStream(videoPath))
                .on('finish', () => {
                    console.log('Video download completed');
                    resolve();
                })
                .on('error', (error) => {
                    console.error('Video download error:', error);
                    reject(error);
                });
            });
        } catch (error) {
            console.error('Download Error:', error);
            return res.status(500).json({ 
                error: true,
                message: 'Failed to download video: ' + error.message 
            });
        }

        const segments = [];
        for (let i = 0; i < parsedTimestamps.length; i++) {
            const startTime = parsedTimestamps[i];
            const endTime = parsedTimestamps[i + 1];
            const segmentPath = path.join(downloadsDir, `${videoTitle}_segment_${i + 1}.mp3`);
            console.log(`Processing segment ${i + 1}: ${startTime} - ${endTime || 'end'}`);

            try {
                await new Promise((resolve, reject) => {
                    const command = ffmpeg(videoPath).setStartTime(startTime);
                    if (endTime !== undefined) {
                        command.setDuration(endTime - startTime);
                    }
                    command
                        .toFormat('mp3')
                        .on('end', () => {
                            console.log(`Segment ${i + 1} processing completed`);
                            resolve();
                        })
                        .on('error', (error) => {
                            console.error(`Segment ${i + 1} processing error:`, error);
                            reject(error);
                        })
                        .save(segmentPath);
                });

                segments.push({
                    path: segmentPath,
                    name: `${videoTitle}_segment_${i + 1}.mp3`
                });
            } catch (error) {
                console.error('FFmpeg Error:', error);
                // Clean up any created files
                segments.forEach(segment => {
                    if (fs.existsSync(segment.path)) {
                        fs.unlinkSync(segment.path);
                    }
                });
                if (fs.existsSync(videoPath)) {
                    fs.unlinkSync(videoPath);
                }
                return res.status(500).json({ 
                    error: true,
                    message: 'Failed to process video segments: ' + error.message 
                });
            }
        }

        // Clean up the original video file
        if (fs.existsSync(videoPath)) {
            fs.unlinkSync(videoPath);
        }

        console.log('All segments processed successfully');
        const response = { 
            error: false,
            success: true, 
            segments: segments.map(s => s.name) 
        };
        console.log('Sending response:', response);
        res.json(response);

    } catch (error) {
        console.error('Unexpected Error:', error);
        res.status(500).json({ 
            error: true,
            message: 'An unexpected error occurred: ' + error.message 
        });
    }
});

app.get('/download/:filename', (req, res) => {
    console.log('Download request for:', req.params.filename);
    try {
        const filename = req.params.filename;
        const filePath = path.join(downloadsDir, filename);
        
        if (!fs.existsSync(filePath)) {
            console.log('File not found:', filename);
            return res.status(404).json({ 
                error: true,
                message: 'File not found' 
            });
        }

        console.log('Streaming file:', filename);
        res.download(filePath, filename, (err) => {
            if (err) {
                console.error('Download error:', err);
                if (!res.headersSent) {
                    res.status(500).json({ 
                        error: true,
                        message: 'Error downloading file: ' + err.message 
                    });
                }
            }
            console.log('File download completed, cleaning up');
            try {
                fs.unlinkSync(filePath);
            } catch (error) {
                console.error('Cleanup error:', error);
            }
        });

    } catch (error) {
        console.error('Download error:', error);
        if (!res.headersSent) {
            res.status(500).json({ 
                error: true,
                message: 'Error downloading file: ' + error.message 
            });
        }
    }
});

app.get('/download-zip', async (req, res) => {
    console.log('Download ZIP request for files:', req.query.files);
    try {
        const files = req.query.files;
        if (!files) {
            console.log('No files specified for ZIP');
            return res.status(400).json({ 
                error: true,
                message: 'No files specified' 
            });
        }

        const fileList = files.split(',').map(f => f.trim());
        console.log('Creating ZIP with files:', fileList);

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename="segments.zip"');
        
        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.pipe(res);

        for (const file of fileList) {
            const filePath = path.join(downloadsDir, file);
            if (fs.existsSync(filePath)) {
                console.log('Adding file to ZIP:', file);
                archive.file(filePath, { name: file });
            }
        }

        archive.on('error', (error) => {
            console.error('Archive error:', error);
            if (!res.headersSent) {
                res.status(500).json({ 
                    error: true,
                    message: 'Error creating zip file: ' + error.message 
                });
            }
        });

        res.on('finish', () => {
            console.log('ZIP download completed, cleaning up files');
            fileList.forEach(file => {
                const filePath = path.join(downloadsDir, file);
                try {
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                    }
                } catch (error) {
                    console.error('Cleanup error:', error);
                }
            });
        });

        await archive.finalize();
        console.log('ZIP archive finalized');

    } catch (error) {
        console.error('Zip error:', error);
        if (!res.headersSent) {
            res.status(500).json({ 
                error: true,
                message: 'Error creating zip file: ' + error.message 
            });
        }
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
}); 
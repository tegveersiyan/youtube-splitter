const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const ytdl = require('ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const { google } = require('googleapis');
const axios = require('axios');
const os = require('os');

// Set FFmpeg paths for different operating systems
const isWindows = os.platform() === 'win32';

let ffmpegPath, ffprobePath;

if (isWindows) {
    // Windows paths - try to find FFmpeg in PATH or common locations
    ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
    ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';
} else {
    // Linux/Mac paths (for Render deployment)
    ffmpegPath = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg';
    ffprobePath = process.env.FFPROBE_PATH || '/usr/bin/ffprobe';
}

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// YouTube API setup
const youtube = google.youtube('v3');
const API_KEY = process.env.YOUTUBE_API_KEY;

// Note: YouTube API key is optional when using ytdl-core
if (!API_KEY) {
    console.warn('Warning: YouTube API key not set. Video titles will be extracted from ytdl-core instead.');
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
    console.log('Request body:', req.body);
    next();
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server Error:', err);
    console.error('Error stack:', err.stack);
    res.status(500).json({ 
        error: true,
        message: 'Server error: ' + err.message 
    });
});

// Ensure JSON responses for API endpoints
app.use((req, res, next) => {
    // Set JSON content type for all API responses
    res.setHeader('Content-Type', 'application/json');
    next();
});

// Test FFmpeg installation
ffmpeg.getAvailableFormats(function(err, formats) {
    if (err) {
        console.error('FFmpeg Error:', err.message);
        console.error('FFmpeg is required for video processing but not found.');
        console.error('');
        console.error('To install FFmpeg:');
        console.error('Windows: Download from https://ffmpeg.org/download.html and add to PATH');
        console.error('macOS: brew install ffmpeg');
        console.error('Linux: sudo apt-get install ffmpeg');
        console.error('');
        console.error('The server will start but video processing will fail without FFmpeg.');
        console.error('Current FFmpeg path:', ffmpegPath);
        console.error('Current FFprobe path:', ffprobePath);
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

        // Get video info using YouTube API or third-party API
        let videoInfo;
        let videoTitle;
        
        if (API_KEY) {
            try {
                console.log('Fetching video info from YouTube API...');
                const videoId = youtubeUrl.split('v=')[1];
                videoInfo = await youtube.videos.list({
                    key: API_KEY,
                    part: 'snippet',
                    id: videoId
                });
                console.log('Video info received:', videoInfo.data.items ? 'Video found' : 'Video not found');
                if (videoInfo.data.items && videoInfo.data.items.length > 0) {
                    videoTitle = videoInfo.data.items[0].snippet.title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
                    console.log('Video title from API:', videoInfo.data.items[0].snippet.title);
                }
            } catch (error) {
                console.error('YouTube API Error:', error);
                console.log('Falling back to third-party API for video info...');
            }
        }
        
        // If API failed or not available, use third-party API
        if (!videoTitle) {
            try {
                console.log('Fetching video info from third-party API...');
                // Extract video ID from URL
                const videoId = youtubeUrl.split('v=')[1]?.split('&')[0];
                if (!videoId) {
                    throw new Error('Invalid YouTube URL');
                }
                
                // Use a more reliable third-party API for video info
                // This API provides video metadata without requiring authentication
                const infoResponse = await axios.get(`https://api.vevioz.com/@api/json/mp3/${videoId}`);
                
                if (infoResponse.data && infoResponse.data.title) {
                    videoTitle = infoResponse.data.title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
                    console.log('Video title from third-party API:', infoResponse.data.title);
                } else {
                    // Fallback: use video ID as title
                    videoTitle = `youtube_video_${videoId}`;
                    console.log('Using video ID as title:', videoTitle);
                }
            } catch (error) {
                console.error('Third-party API Error:', error);
                // Fallback: use video ID as title
                const videoId = youtubeUrl.split('v=')[1]?.split('&')[0];
                if (videoId) {
                    videoTitle = `youtube_video_${videoId}`;
                    console.log('Using video ID as fallback title:', videoTitle);
                } else {
                    return res.status(500).json({ 
                        error: true,
                        message: 'Failed to fetch video information: ' + error.message 
                    });
                }
            }
        }

        if (!videoTitle) {
            console.log('Could not get video title');
            return res.status(404).json({ 
                error: true,
                message: 'Video not found or is not accessible' 
            });
        }

        const videoPath = path.join(downloadsDir, `${videoTitle}.mp3`);
        console.log('Processing video:', videoTitle);
        console.log('Video path:', videoPath);

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

        // Download video using RapidAPI
        try {
            console.log('Starting video download...');
            console.log('Video URL:', youtubeUrl);

            // Extract video ID
            const videoId = youtubeUrl.split('v=')[1]?.split('&')[0];
            if (!videoId) {
                throw new Error('Invalid YouTube URL');
            }

            console.log('Video ID:', videoId);

            // Call RapidAPI for MP3 link
            const options = {
                method: 'GET',
                url: 'https://youtube-mp36.p.rapidapi.com/dl',
                params: { id: videoId },
                headers: {
                    'X-RapidAPI-Key': process.env.RAPIDAPI_KEY || 'a4da6936ffmshf4958e64506a344p1e8481jsna7cb80f8f9fa',
                    'X-RapidAPI-Host': 'youtube-mp36.p.rapidapi.com'
                }
            };

            console.log('Calling RapidAPI...');
            const response = await axios.request(options);

            console.log('RapidAPI response:', response.data);

            if (!response.data || response.data.status !== 'ok' || !response.data.link) {
                throw new Error('No download URL available from RapidAPI: ' + (response.data?.msg || 'Unknown error'));
            }

            const mp3Url = response.data.link;
            console.log('MP3 URL received:', mp3Url);

            const writeStream = fs.createWriteStream(videoPath);
            const mp3Response = await axios({ 
                method: 'GET', 
                url: mp3Url, 
                responseType: 'stream' 
            });
            
            mp3Response.data.pipe(writeStream);

            await new Promise((resolve, reject) => {
                writeStream.on('finish', () => {
                    console.log('MP3 download completed');
                    resolve();
                });
                writeStream.on('error', (error) => {
                    console.error('Write stream error:', error);
                    reject(error);
                });
                mp3Response.data.on('error', (error) => {
                    console.error('Download stream error:', error);
                    reject(error);
                });
            });

            // Verify the file was downloaded
            if (!fs.existsSync(videoPath)) {
                throw new Error('Download completed but file not found at: ' + videoPath);
            }
            
            const stats = fs.statSync(videoPath);
            if (stats.size === 0) {
                throw new Error('Downloaded file is empty');
            }
            
            console.log('Video download completed successfully. File size:', stats.size);

        } catch (error) {
            console.error('Download Error:', error);
            console.error('Error details:', {
                message: error.message,
                code: error.code,
                statusCode: error.statusCode,
                stack: error.stack
            });
            
            // Clean up any partial download
            if (fs.existsSync(videoPath)) {
                fs.unlinkSync(videoPath);
            }
            
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
                    const command = ffmpeg(videoPath)
                        .setStartTime(startTime)
                        .on('start', (commandLine) => {
                            console.log('FFmpeg command:', commandLine);
                        })
                        .on('progress', (progress) => {
                            console.log(`Segment ${i + 1} progress:`, progress);
                        });

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
        console.error('Error stack:', error.stack);
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

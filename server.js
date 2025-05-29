const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const youtubeDl = require('youtube-dl-exec');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');

// Set FFmpeg paths
const ffmpegPath = process.env.FFMPEG_PATH || 'C:\\ffmpeg\\bin\\ffmpeg.exe';
const ffprobePath = process.env.FFPROBE_PATH || 'C:\\ffmpeg\\bin\\ffprobe.exe';
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// Create downloads directory if it doesn't exist
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir);
}

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server Error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
});

// Add this before other routes
app.use((req, res, next) => {
    res.setHeader('Content-Type', 'application/json');
    next();
});

// Test FFmpeg installation
ffmpeg.getAvailableFormats(function(err, formats) {
    if (err) {
        console.error('FFmpeg Error:', err);
    } else {
        console.log('FFmpeg is properly installed and accessible');
    }
});

app.post('/split-video', async (req, res) => {
    try {
        const { youtubeUrl, timestamps } = req.body;
        
        if (!youtubeUrl || !timestamps || !Array.isArray(timestamps)) {
            return res.status(400).json({ error: 'Invalid input' });
        }

        console.log('Processing URL:', youtubeUrl);
        console.log('Raw Timestamps:', timestamps);

        // Parse timestamps: support mm:ss or seconds
        timestamps = timestamps.map(ts => {
            if (typeof ts === 'string' && ts.includes(':')) {
                const parts = ts.split(':').map(Number);
                if (parts.length === 2) {
                    return parts[0] * 60 + parts[1];
                } else if (parts.length === 3) {
                    return parts[0] * 3600 + parts[1] * 60 + parts[2];
                }
            }
            return Number(ts);
        }).filter(ts => !isNaN(ts)).sort((a, b) => a - b);

        if (timestamps.length === 0) {
            return res.status(400).json({ error: 'No valid timestamps provided' });
        }

        // Add 0 at the start if not present
        if (timestamps[0] !== 0) {
            timestamps.unshift(0);
        }

        console.log('Parsed Timestamps (in seconds):', timestamps);

        // Get video info
        console.log('Getting video info...');
        const videoInfo = await youtubeDl(youtubeUrl, {
            dumpSingleJson: true,
            noWarnings: true,
            noCallHome: true,
            noCheckCertificate: true,
            preferFreeFormats: true,
            youtubeSkipDashManifest: true,
            ffmpegLocation: path.dirname(ffmpegPath)
        }).catch(err => {
            console.error('Error getting video info:', err);
            throw new Error('Failed to get video information: ' + err.message);
        });

        const videoTitle = videoInfo.title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        
        // Download video
        const videoPath = path.join(downloadsDir, `${videoTitle}.mp3`);
        
        console.log('Downloading video...');
        await youtubeDl(youtubeUrl, {
            output: videoPath,
            extractAudio: true,
            audioFormat: 'mp3',
            audioQuality: 0,
            noWarnings: true,
            noCallHome: true,
            noCheckCertificate: true,
            preferFreeFormats: true,
            youtubeSkipDashManifest: true,
            ffmpegLocation: path.dirname(ffmpegPath)
        }).catch(err => {
            console.error('Error downloading video:', err);
            throw new Error('Failed to download video: ' + err.message);
        });

        console.log('Splitting audio into segments...');
        // Split audio into segments
        const segments = [];
        for (let i = 0; i < timestamps.length; i++) {
            const startTime = timestamps[i];
            const endTime = timestamps[i + 1];
            const segmentPath = path.join(downloadsDir, `${videoTitle}_segment_${i + 1}.mp3`);

            console.log(`Processing segment ${i + 1}: ${startTime} to ${endTime !== undefined ? endTime : 'end'}`);
            await new Promise((resolve, reject) => {
                const command = ffmpeg(videoPath)
                    .setStartTime(startTime);
                if (endTime !== undefined) {
                    command.setDuration(endTime - startTime);
                }
                command
                    .toFormat('mp3')
                    .on('end', () => {
                        console.log(`Segment ${i + 1} completed`);
                        resolve();
                    })
                    .on('error', (err) => {
                        console.error(`Error processing segment ${i + 1}:`, err);
                        reject(new Error(`Failed to process segment ${i + 1}: ${err.message}`));
                    })
                    .save(segmentPath);
            }).catch(err => {
                throw new Error(`Failed to process segment ${i + 1}: ${err.message}`);
            });

            segments.push({
                path: segmentPath,
                name: `${videoTitle}_segment_${i + 1}.mp3`
            });
        }

        // Clean up original files
        console.log('Cleaning up temporary files...');
        fs.unlinkSync(videoPath);

        console.log('Process completed successfully');
        res.json({ 
            success: true, 
            segments: segments.map(s => s.name)
        });

    } catch (error) {
        console.error('Detailed error:', error);
        res.status(500).json({ error: 'Failed to process video: ' + error.message });
    }
});

app.get('/download/:filename', (req, res) => {
    try {
        const filename = req.params.filename;
        const filePath = path.join(downloadsDir, filename);
        
        if (fs.existsSync(filePath)) {
            res.download(filePath, filename, (err) => {
                if (err) {
                    console.error('Download error:', err);
                    res.status(500).json({ error: 'Error downloading file: ' + err.message });
                }
                // Delete file after download
                fs.unlinkSync(filePath);
            });
        } else {
            res.status(404).json({ error: 'File not found' });
        }
    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({ error: 'Error downloading file: ' + error.message });
    }
});

app.get('/download-zip', async (req, res) => {
    try {
        const files = req.query.files;
        if (!files) {
            return res.status(400).json({ error: 'No files specified' });
        }
        const fileList = files.split(',').map(f => f.trim());
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename="segments.zip"');
        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.pipe(res);
        for (const file of fileList) {
            const filePath = path.join(downloadsDir, file);
            if (fs.existsSync(filePath)) {
                archive.file(filePath, { name: file });
            }
        }
        archive.finalize();
    } catch (error) {
        console.error('Zip error:', error);
        res.status(500).json({ error: 'Error creating zip file: ' + error.message });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
}); 
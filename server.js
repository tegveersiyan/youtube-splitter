const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const YTDlpWrap = require('yt-dlp-wrap').default;
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const { execSync } = require('child_process');

// Set FFmpeg paths for Render
const ffmpegPath = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg';
const ffprobePath = process.env.FFPROBE_PATH || '/usr/bin/ffprobe';
const cookiesPath = path.join(__dirname, 'youtube.com_cookies.txt');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// Check if cookies file exists
if (!fs.existsSync(cookiesPath)) {
    console.warn('Warning: YouTube cookies file not found. Some videos may require authentication.');
}

// Function to install yt-dlp
async function ensureYtDlp() {
    try {
        const ytDlp = new YTDlpWrap();
        await ytDlp.getVersion();
        console.log('yt-dlp is installed');
    } catch (error) {
        console.log('Installing yt-dlp...');
        try {
            // Install yt-dlp in the project directory without sudo
            const ytDlpPath = path.join(__dirname, 'yt-dlp');
            execSync(`curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o "${ytDlpPath}" && chmod a+rx "${ytDlpPath}"`, { stdio: 'inherit' });
            // Set the path to include the current directory
            process.env.PATH = `${__dirname}:${process.env.PATH}`;
            console.log('yt-dlp installed successfully');
        } catch (installError) {
            console.error('Failed to install yt-dlp:', installError);
            throw new Error('Failed to install yt-dlp. Please check the Render logs for more details.');
        }
    }
}

// Initialize yt-dlp
let ytDlp;
(async () => {
    try {
        await ensureYtDlp();
        ytDlp = new YTDlpWrap();
    } catch (error) {
        console.error('Failed to initialize yt-dlp:', error);
    }
})();

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
        if (!ytDlp) {
            await ensureYtDlp();
            ytDlp = new YTDlpWrap();
        }

        const { youtubeUrl, timestamps: rawTimestamps } = req.body;
        
        if (!youtubeUrl || !rawTimestamps || !Array.isArray(rawTimestamps)) {
            return res.status(400).json({ error: 'Invalid input' });
        }

        const parsedTimestamps = rawTimestamps.map(ts => {
            if (typeof ts === 'string' && ts.includes(':')) {
                const parts = ts.split(':').map(Number);
                if (parts.length === 2) return parts[0] * 60 + parts[1];
                if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
            }
            return Number(ts);
        }).filter(ts => !isNaN(ts)).sort((a, b) => a - b);

        if (parsedTimestamps.length === 0) {
            return res.status(400).json({ error: 'No valid timestamps provided' });
        }

        if (parsedTimestamps[0] !== 0) {
            parsedTimestamps.unshift(0);
        }

        const videoInfo = await ytDlp.getVideoInfo(youtubeUrl);
        const videoTitle = videoInfo.title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const videoPath = path.join(downloadsDir, `${videoTitle}.mp3`);
        
        await ytDlp.exec([
            youtubeUrl,
            '-x',
            '--audio-format', 'mp3',
            '--audio-quality', '0',
            '-o', videoPath,
            '--no-warnings',
            '--no-call-home',
            '--no-check-certificate',
            '--prefer-free-formats',
            '--youtube-skip-dash-manifest',
            '--format', 'bestaudio/best'
        ]);

        const segments = [];
        for (let i = 0; i < parsedTimestamps.length; i++) {
            const startTime = parsedTimestamps[i];
            const endTime = parsedTimestamps[i + 1];
            const segmentPath = path.join(downloadsDir, `${videoTitle}_segment_${i + 1}.mp3`);

            await new Promise((resolve, reject) => {
                const command = ffmpeg(videoPath).setStartTime(startTime);
                if (endTime !== undefined) {
                    command.setDuration(endTime - startTime);
                }
                command
                    .toFormat('mp3')
                    .on('end', resolve)
                    .on('error', reject)
                    .save(segmentPath);
            });

            segments.push({
                path: segmentPath,
                name: `${videoTitle}_segment_${i + 1}.mp3`
            });
        }

        fs.unlinkSync(videoPath);
        res.json({ success: true, segments: segments.map(s => s.name) });

    } catch (error) {
        console.error('Error:', error);
        if (error.message.includes('Status code: 410')) {
            return res.status(400).json({ error: 'This video is no longer available on YouTube' });
        }
        if (error.message.includes('Status code: 403')) {
            return res.status(400).json({ error: 'This video is not available for download' });
        }
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
    console.log(`Server running on port ${port}`);
}); 
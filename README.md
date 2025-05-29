# YouTube Video Splitter

A web application that allows you to split YouTube videos into MP3 segments based on timestamps.

## Prerequisites

- Node.js (v14 or higher)
- FFmpeg installed on your system

### Installing FFmpeg

#### Windows
1. Download FFmpeg from https://ffmpeg.org/download.html
2. Add FFmpeg to your system PATH

#### macOS
```bash
brew install ffmpeg
```

#### Linux
```bash
sudo apt-get install ffmpeg
```

## Installation

1. Clone this repository
2. Install dependencies:
```bash
npm install
```

## Usage

1. Start the server:
```bash
npm start
```

2. Open your browser and navigate to `http://localhost:3000`

3. Enter a YouTube URL and add timestamps (in seconds) where you want to split the video

4. Click "Split Video" and wait for the processing to complete

5. Download the resulting MP3 segments

## Features

- Split YouTube videos into MP3 segments
- Modern, responsive user interface
- Automatic cleanup of temporary files
- Support for multiple segments
- Progress indication during processing

## Notes

- The application processes videos on the server side
- Processing time depends on the video length and number of segments
- Make sure you have sufficient disk space for temporary files
- The application automatically cleans up temporary files after processing 
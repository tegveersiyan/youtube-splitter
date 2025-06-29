const http = require('http');

function testVideoSplit() {
    const testData = {
        youtubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        timestamps: ['30']
    };

    console.log('Testing video split with:', testData);

    const postData = JSON.stringify(testData);

    const options = {
        hostname: 'localhost',
        port: 3000,
        path: '/split-video',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        }
    };

    const req = http.request(options, (res) => {
        console.log(`Status: ${res.statusCode}`);
        
        let data = '';
        res.on('data', (chunk) => {
            data += chunk;
        });
        
        res.on('end', () => {
            try {
                const response = JSON.parse(data);
                console.log('Response:', response);
                
                if (response.error) {
                    console.error('Error:', response.message);
                } else {
                    console.log('Success! Segments created:', response.segments);
                }
            } catch (error) {
                console.error('Failed to parse response:', error.message);
                console.log('Raw response:', data);
            }
        });
    });

    req.on('error', (error) => {
        console.error('Test failed:', error.message);
    });

    req.write(postData);
    req.end();
}

testVideoSplit(); 
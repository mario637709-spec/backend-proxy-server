const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

const platform = os.platform();
let binaryName = 'yt-dlp';
if (platform === 'win32') {
  binaryName = 'yt-dlp.exe';
} else if (platform === 'darwin') {
  binaryName = 'yt-dlp_macos';
}

const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${binaryName}`;
const dest = path.join(__dirname, platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

console.log(`Downloading yt-dlp for ${platform} from ${url}...`);

const file = fs.createWriteStream(dest);

function download(url, destFile) {
  https.get(url, (response) => {
    if (response.statusCode === 301 || response.statusCode === 302) {
      return download(response.headers.location, destFile);
    }
    
    response.pipe(destFile);
    
    destFile.on('finish', () => {
      destFile.close();
      console.log('Download complete!');
      
      // Make executable on Linux/Mac
      if (platform !== 'win32') {
        fs.chmodSync(dest, 0o755);
        console.log('Granted execute permissions.');
      }
    });
  }).on('error', (err) => {
    fs.unlink(dest, () => {});
    console.error('Error downloading yt-dlp:', err.message);
  });
}

download(url, file);

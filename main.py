from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import yt_dlp
import os

app = FastAPI(title="YTDown Lightweight Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
def health():
    return {"status": "healthy", "engine": "FastAPI + Native yt-dlp Python"}

@app.get("/api/getVideoJson")
def get_video_json(videoId: str, poToken: str = None):
    if not videoId:
        raise HTTPException(status_code=400, detail="videoId is required")

    url = f"https://www.youtube.com/watch?v={videoId}"
    tunnel_proxy = os.getenv("TUNNEL_URL")

    # Ensure http:// scheme for proxy compatibility if set
    if tunnel_proxy and not tunnel_proxy.startswith("http://") and not tunnel_proxy.startswith("https://"):
        tunnel_proxy = f"http://{tunnel_proxy}"

    ydl_opts = {
        'skip_download': True,
        'quiet': True,
        'no_warnings': True,
        'geo_bypass': True,
        'extractor_args': {
            'youtube': {
                'player_client': ['mweb', 'ios', 'android_vr', 'web']
            }
        }
    }

    if tunnel_proxy:
        ydl_opts['proxy'] = tunnel_proxy

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            
            formats = []
            for f in info.get('formats', []):
                if f.get('ext') in ['mp4', 'webm', 'm4a']:
                    formats.append({
                        'format_id': f.get('format_id'),
                        'ext': f.get('ext'),
                        'resolution': f.get('resolution') or f.get('format_note') or 'Audio Only',
                        'filesize': f.get('filesize') or f.get('filesize_approx') or 0,
                        'url': f.get('url'),
                        'vcodec': f.get('vcodec') if f.get('vcodec') != 'none' else None,
                        'acodec': f.get('acodec') if f.get('acodec') != 'none' else None,
                    })

            return {
                "title": info.get('title'),
                "thumbnail": info.get('thumbnail'),
                "duration": str(info.get('duration', 0)),
                "uploader": info.get('uploader'),
                "formats": formats
            }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

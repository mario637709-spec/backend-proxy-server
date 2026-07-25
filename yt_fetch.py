import sys
import json
import yt_dlp
import re

def fetch(url):
    ydl_opts = {
        'quiet': True,
        'dump_single_json': True,
        'extract_flat': False,
        'no_warnings': True,
        # 'cookiesfrombrowser': ('chrome',), # Optional: Can be passed via args if needed
    }
    
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            print(json.dumps(info))
            sys.exit(0)
    except Exception as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("URL required", file=sys.stderr)
        sys.exit(1)
    fetch(sys.argv[1])

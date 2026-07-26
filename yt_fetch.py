import sys
import json
import yt_dlp
import argparse
import os

def fetch(url, po_token=None, visitor_data=None, cookies_file=None, proxy=None):
    ydl_opts = {
        'quiet': True,
        'dump_single_json': True,
        'extract_flat': False,
        'no_warnings': True,
    }
    
    # ✅ PROXY SUPPORT - Use laptop proxy if provided
    if proxy:
        ydl_opts['proxy'] = proxy
        print(f"🌐 Using proxy: {proxy}", file=sys.stderr)
    elif os.getenv('YT_DLP_PROXY'):
        ydl_opts['proxy'] = os.getenv('YT_DLP_PROXY')
        print(f"🌐 Using env proxy: {os.getenv('YT_DLP_PROXY')}", file=sys.stderr)
    
    if cookies_file:
        ydl_opts['cookiefile'] = cookies_file
        
    extractor_args = []
    if po_token:
        extractor_args.append(f'po_token=web+{po_token}')
    if visitor_data:
        extractor_args.append(f'visitor_data={visitor_data}')
        
    if extractor_args:
        # e.g., 'youtube:player_client=web;po_token=...;visitor_data=...'
        ydl_opts['extractor_args'] = {'youtube': ['player_client=web', *extractor_args]}
    
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            print(json.dumps(info))
            sys.exit(0)
    except Exception as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Fetch YouTube video info.')
    parser.add_argument('url', help='YouTube video URL')
    parser.add_argument('--po-token', help='PO Token')
    parser.add_argument('--visitor-data', help='Visitor Data')
    parser.add_argument('--cookies', help='Path to cookies file')
    parser.add_argument('--proxy', help='HTTP/HTTPS proxy (e.g., http://localhost:8080)')
    
    args = parser.parse_args()
    fetch(args.url, po_token=args.po_token, visitor_data=args.visitor_data, cookies_file=args.cookies, proxy=args.proxy)

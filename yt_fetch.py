import sys
import json
import yt_dlp
import argparse
import os

import sys
import json
import yt_dlp
import argparse
import os
import re
from urllib.parse import urlparse, parse_qs

# Player clients to try in order - ios/android bypass bot detection on datacenter IPs
PLAYER_CLIENTS = ['mweb', 'android', 'ios', 'web']

def extract_video_id(url_or_id):
    if not url_or_id or not isinstance(url_or_id, str):
        return None
    val = url_or_id.strip()

    # 1. Direct 11-character video ID
    if re.match(r'^[a-zA-Z0-9_-]{11}$', val):
        return val

    # 2. Try URL parsing
    try:
        target_str = val if ('://' in val or val.startswith('http')) else 'https://' + val
        parsed = urlparse(target_str)
        qs = parse_qs(parsed.query)
        if 'v' in qs and qs['v']:
            v_id = qs['v'][0]
            if re.match(r'^[a-zA-Z0-9_-]{11}$', v_id):
                return v_id

        if 'youtu.be' in parsed.netloc:
            path_id = parsed.path.lstrip('/').split('/')[0]
            if re.match(r'^[a-zA-Z0-9_-]{11}$', path_id):
                return path_id

        match = re.search(r'/(?:embed|shorts|v|video)/([a-zA-Z0-9_-]{11})', parsed.path)
        if match:
            return match.group(1)
    except Exception:
        pass

    # 3. Fallback regex search
    match = re.search(r'[?&]v=([a-zA-Z0-9_-]{11})|youtu\.be\/([a-zA-Z0-9_-]{11})|\/(?:embed|shorts|v)\/([a-zA-Z0-9_-]{11})', val)
    if match:
        for g in match.groups():
            if g and re.match(r'^[a-zA-Z0-9_-]{11}$', g):
                return g

    return val

def fetch(raw_url, po_token=None, visitor_data=None, cookies_file=None, proxy=None):
    video_id = extract_video_id(raw_url)
    if video_id and len(video_id) == 11:
        url = f"https://www.youtube.com/watch?v={video_id}"
        print(f"🧹 Cleaned URL video ID: {video_id} -> {url}", file=sys.stderr)
    else:
        url = raw_url
    
    last_error = None

    for client in PLAYER_CLIENTS:
        ydl_opts = {
            'quiet': True,
            'dump_single_json': True,
            'extract_flat': False,
            'noplaylist': True,
            'no_warnings': True,
        }

        # Use laptop proxy if provided
        if proxy:
            ydl_opts['proxy'] = proxy
            print(f"🌐 Using proxy: {proxy}", file=sys.stderr)
        elif os.getenv('YT_DLP_PROXY'):
            ydl_opts['proxy'] = os.getenv('YT_DLP_PROXY')
            print(f"🌐 Using env proxy: {os.getenv('YT_DLP_PROXY')}", file=sys.stderr)

        if cookies_file:
            ydl_opts['cookiefile'] = cookies_file

        # Build extractor_args for this client
        extractor_args = [f'player_client={client}']
        if po_token and client == 'web':
            extractor_args.append(f'po_token=web+{po_token}')
        if visitor_data and client == 'web':
            extractor_args.append(f'visitor_data={visitor_data}')

        ydl_opts['extractor_args'] = {'youtube': extractor_args}

        print(f"🎯 Trying player_client={client}...", file=sys.stderr)

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                print(f"✅ Success with player_client={client}", file=sys.stderr)
                print(json.dumps(info))
                sys.exit(0)
        except Exception as e:
            last_error = str(e)
            print(f"❌ Failed with player_client={client}: {last_error}", file=sys.stderr)
            continue

    # All clients failed
    print(last_error, file=sys.stderr)
    sys.exit(1)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Fetch YouTube video info.')
    parser.add_argument('url', help='YouTube video URL')
    parser.add_argument('--po-token', help='PO Token')
    parser.add_argument('--visitor-data', help='Visitor Data')
    parser.add_argument('--cookies', help='Path to cookies file')
    parser.add_argument('--proxy', help='HTTP/HTTPS proxy (e.g., http://localhost:8080)')

    args = parser.parse_args()
    fetch(args.url, po_token=args.po_token, visitor_data=args.visitor_data,
          cookies_file=args.cookies, proxy=args.proxy)

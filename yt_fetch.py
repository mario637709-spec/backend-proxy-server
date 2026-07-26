import sys
import json
import yt_dlp
import argparse
import os

# Player clients to try in order - ios/android bypass bot detection on datacenter IPs
PLAYER_CLIENTS = ['ios', 'android', 'web']

def fetch(url, po_token=None, visitor_data=None, cookies_file=None, proxy=None):
    
    last_error = None

    for client in PLAYER_CLIENTS:
        ydl_opts = {
            'quiet': True,
            'dump_single_json': True,
            'extract_flat': False,
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
            # If not bot-related error, don't retry
            if 'Sign in' not in last_error and 'bot' not in last_error.lower():
                break
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

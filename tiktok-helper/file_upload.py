#!/usr/bin/env python3
"""
Upload and publish video via the PM3K API (https://pm3k.org/docs#video-source).

Features:
- Supports remote video sources (URL from verified storage/CDN per #video-source)
- Supports direct multipart/form-data local file upload
- Supports uploading local video to Vercel Blob first, then publishing via video-source URL
- Configurable post metadata (caption, privacy level, permissions)
- Automated status polling until publishing completes or fails

Usage:
python file_upload.py \
  --url "https://storage.yourdomain.com/videos/sample.mp4" \
  --caption "Check out this reel! #trending" \
  --privacy "PUBLIC_TO_EVERYONE"

python file_upload.py \
  --file "/path/to/local/video.mp4" \
  --caption "Fresh local upload #fyp" \
  --privacy "SELF_ONLY"

python file_upload.py \
  --file "/path/to/local/video.mp4" \
  --blob-upload \
  --caption "Uploaded via Vercel Blob #fyp"
"""

import argparse
import mimetypes
import os
import posixpath
import sys
import time
from typing import Any, Dict, Optional
import requests

PM3K_API_BASE = os.getenv("PM3K_API_BASE", "https://api.pm3k.org/v1")


def upload_to_vercel_blob(
    file_path: str,
    token: Optional[str] = None,
    pathname_prefix: str = "videos",
    custom_base_url: Optional[str] = None,
) -> str:
    """
    Uploads a local file to Vercel Blob storage using the Vercel Blob API.
    Returns the public URL (or custom domain mapped URL) for the uploaded file.
    """
    token = token or os.getenv("BLOB_READ_WRITE_TOKEN")
    if not token:
        raise ValueError("BLOB_READ_WRITE_TOKEN is required for Vercel Blob uploads.")

    filename = os.path.basename(file_path)
    blob_pathname = posixpath.join(pathname_prefix, filename)
    content_type, _ = mimetypes.guess_type(file_path)
    content_type = content_type or "video/mp4"

    upload_endpoint = f"https://blob.vercel-storage.com/{blob_pathname}"
    headers = {
        "authorization": f"Bearer {token}",
        "x-api-version": "7",
        "x-content-type": content_type,
    }

    with open(file_path, "rb") as f:
        resp = requests.put(upload_endpoint, headers=headers, data=f, timeout=120)
    resp.raise_for_status()
    data = resp.json()
    blob_url = data.get("url")

    if custom_base_url and blob_url:
        # Remap default blob storage hostname to custom verified domain if requested
        path_part = data.get("pathname", blob_pathname)
        blob_url = f"{custom_base_url.rstrip('/')}/{path_part.lstrip('/')}"

    return blob_url

class PM3KClient:
    def __init__(self, api_key: str, base_url: str = PM3K_API_BASE):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()
        self.session.headers.update({
            "Authorization": f"Bearer {self.api_key}",
            "x-api-key": self.api_key,
        })

    def post_video_source(
        self,
        video_url: str,
        caption: str,
        account_id: Optional[str] = None,
        privacy_level: str = "PUBLIC_TO_EVERYONE",
        disable_comment: bool = False,
        disable_duet: bool = False,
        disable_stitch: bool = False,
    ) -> Dict[str, Any]:
        """
        Publishes a video by pointing to a publicly reachable / verified video URL
        per the PM3K video-source documentation.
        """
        endpoint = f"{self.base_url}/posts"
        payload = {
            "source_type": "PULL_FROM_URL",
            "video_url": video_url,
            "caption": caption,
            "privacy_level": privacy_level,
            "disable_comment": disable_comment,
            "disable_duet": disable_duet,
            "disable_stitch": disable_stitch,
        }
        if account_id:
            payload["account_id"] = account_id

        response = self.session.post(endpoint, json=payload, timeout=30)
        response.raise_for_status()
        return response.json()

    def upload_local_video(
        self,
        file_path: str,
        caption: str,
        account_id: Optional[str] = None,
        privacy_level: str = "PUBLIC_TO_EVERYONE",
        disable_comment: bool = False,
        disable_duet: bool = False,
        disable_stitch: bool = False,
    ) -> Dict[str, Any]:
        """
        Uploads and publishes a local video file using multipart/form-data.
        """
        if not os.path.isfile(file_path):
            raise FileNotFoundError(f"Local video file not found: {file_path}")

        endpoint = f"{self.base_url}/posts"
        data = {
            "source_type": "FILE_UPLOAD",
            "caption": caption,
            "privacy_level": privacy_level,
            "disable_comment": str(disable_comment).lower(),
            "disable_duet": str(disable_duet).lower(),
            "disable_stitch": str(disable_stitch).lower(),
        }
        if account_id:
            data["account_id"] = account_id

        with open(file_path, "rb") as f:
            files = {"video": (os.path.basename(file_path), f, "video/mp4")}
            response = self.session.post(endpoint, data=data, files=files, timeout=120)

        response.raise_for_status()
        return response.json()

    def get_post_status(self, publish_id: str) -> Dict[str, Any]:
        """
        Polls the status of an ongoing video publish job.
        """
        endpoint = f"{self.base_url}/posts/{publish_id}/status"
        response = self.session.get(endpoint, timeout=15)
        response.raise_for_status()
        return response.json()

    def wait_for_completion(
        self,
        publish_id: str,
        poll_interval: int = 5,
        max_attempts: int = 24,
    ) -> Dict[str, Any]:
        """
        Polls the status endpoint until success or failure.
        """
        print(f"[*] Monitoring publish status for ID: {publish_id}")
        for attempt in range(1, max_attempts + 1):
            time.sleep(poll_interval)
            try:
                res = self.get_post_status(publish_id)
                status = res.get("status", "").upper()
                print(f"    [Poll {attempt}/{max_attempts}] Current status: {status}")

                if status in ("SUCCESS", "PUBLISHED", "COMPLETED"):
                    print("[+] Video published successfully!")
                    return res
                if status in ("FAILED", "ERROR"):
                    error_msg = res.get("error") or res.get("message") or "Unknown error"
                    raise RuntimeError(f"Video publish failed: {error_msg}")
            except requests.RequestException as exc:
                print(f"    [Warning] Status check request error: {exc}")

        raise TimeoutError("Publish status check timed out before reaching completion.")


def main():
    parser = argparse.ArgumentParser(
        description="Upload or publish video via PM3K API",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--url", help="Direct public/verified URL of the video (video-source mode)")
    group.add_argument("--file", help="Path to local video file for direct upload")

    parser.add_argument(
        "--blob-upload",
        action="store_true",
        help="Upload --file to Vercel Blob first and submit to PM3K as a verified video URL",
    )
    parser.add_argument(
        "--blob-custom-domain",
        default=os.getenv("BLOB_CUSTOM_DOMAIN"),
        help="Base domain to use for verified URL (e.g. https://repost-app-ytdlp-helper.vercel.app)",
    )
    parser.add_argument("--blob-token", default=os.getenv("BLOB_READ_WRITE_TOKEN"), help="Vercel Blob token")
    parser.add_argument("--caption", "-c", required=True, help="Video caption/description")
    parser.add_argument(
        "--privacy",
        choices=["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"],
        default="PUBLIC_TO_EVERYONE",
        help="Target privacy level",
    )
    parser.add_argument("--account-id", help="Connected target account ID (if multiple connected)")
    parser.add_argument("--api-key", default=os.getenv("PM3K_API_KEY"), help="PM3K API Key (or set PM3K_API_KEY env)")
    parser.add_argument("--no-wait", action="store_true", help="Do not wait for publish confirmation")

    args = parser.parse_args()

    if not args.api_key:
        print("Error: Missing API key. Pass via --api-key or set PM3K_API_KEY environment variable.", file=sys.stderr)
        sys.exit(1)

    client = PM3KClient(api_key=args.api_key)

    try:
        if args.url:
            print(f"[*] Initiating post via video source URL: {args.url}")
            res = client.post_video_source(
                video_url=args.url,
                caption=args.caption,
                account_id=args.account_id,
                privacy_level=args.privacy,
            )
        elif args.blob_upload:
            print(f"[*] Uploading {args.file} to Vercel Blob...")
            blob_url = upload_to_vercel_blob(
                file_path=args.file,
                token=args.blob_token,
                custom_base_url=args.blob_custom_domain,
            )
            print(f"[+] Uploaded to Vercel Blob: {blob_url}")
            print("[*] Initiating post via video source URL...")
            res = client.post_video_source(
                video_url=blob_url,
                caption=args.caption,
                account_id=args.account_id,
                privacy_level=args.privacy,
            )
        else:
            print(f"[*] Uploading local video file: {args.file}")
            res = client.upload_local_video(
                file_path=args.file,
                caption=args.caption,
                account_id=args.account_id,
                privacy_level=args.privacy,
            )

        publish_id = res.get("publish_id") or res.get("id") or (res.get("data") or {}).get("publish_id")
        print(f"[+] Initial submission successful. Response: {res}")

        if publish_id and not args.no_wait:
            client.wait_for_completion(publish_id)

    except Exception as exc:
        print(f"[-] Execution error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

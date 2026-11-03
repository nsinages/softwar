import os

# Base directory of the project
BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))

# Media directory where uploaded videos and images are stored on the SD card
MEDIA_FOLDER = os.path.join(BASE_DIR, 'media')

# Data directory for any persistent internal data
DATA_FOLDER = os.path.join(BASE_DIR, 'data')

# Server network configurations
HOST = os.environ.get('NSIGNAGE_HOST', '0.0.0.0')
PORT = int(os.environ.get('NSIGNAGE_PORT', '5000'))

# Shared secret required for uploads/deletes (header X-API-Key).
# Empty = no authentication (only acceptable on a fully trusted network).
API_KEY = os.environ.get('NSIGNAGE_API_KEY', '').strip()

# File upload settings (500 MB max content length to support large videos)
MAX_CONTENT_LENGTH = 500 * 1024 * 1024

# Supported media extensions
VIDEO_EXTENSIONS = {'mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v'}
IMAGE_EXTENSIONS = {'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'}
ALLOWED_EXTENSIONS = VIDEO_EXTENSIONS.union(IMAGE_EXTENSIONS)

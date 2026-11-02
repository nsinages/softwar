import os
import socket
import logging
from urllib.parse import unquote
from flask import Flask, jsonify, request, send_from_directory, render_template
from werkzeug.utils import secure_filename
import config

# Try importing flask_cors if available
try:
    from flask_cors import CORS
    HAS_FLASK_CORS = True
except ImportError:
    HAS_FLASK_CORS = False

# Initialize Flask app pointing to root templates and static folders
app = Flask(
    __name__,
    template_folder=os.path.join(config.BASE_DIR, 'templates'),
    static_folder=os.path.join(config.BASE_DIR, 'static')
)

if HAS_FLASK_CORS:
    CORS(app, resources={r"/*": {"origins": "*"}}, methods=["GET", "POST", "DELETE", "OPTIONS"])

app.config['MAX_CONTENT_LENGTH'] = config.MAX_CONTENT_LENGTH

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger('n-signage')

# Ensure media and data folders exist
os.makedirs(config.MEDIA_FOLDER, exist_ok=True)
os.makedirs(config.DATA_FOLDER, exist_ok=True)


def get_device_ip():
    """
    Dynamically detect the Raspberry Pi network interface IP address.
    Does not hardcode IP and falls back gracefully.
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # Connecting to an unroutable LAN IP retrieves the active route interface IP
        s.connect(('10.255.255.255', 1))
        ip = s.getsockname()[0]
    except Exception:
        try:
            s.connect(('8.8.8.8', 80))
            ip = s.getsockname()[0]
        except Exception:
            ip = '127.0.0.1'
    finally:
        s.close()
    return ip


def get_media_type(filename):
    """Determine whether a file is a video or an image based on extension."""
    ext = filename.rsplit('.', 1)[-1].lower() if '.' in filename else ''
    if ext in config.VIDEO_EXTENSIONS:
        return 'video'
    elif ext in config.IMAGE_EXTENSIONS:
        return 'image'
    return 'unknown'


def is_allowed_file(filename):
    """Check if filename has a supported media extension."""
    if '.' not in filename:
        return False
    ext = filename.rsplit('.', 1)[-1].lower()
    return ext in config.ALLOWED_EXTENSIONS


@app.before_request
def handle_preflight():
    """Handle all CORS preflight OPTIONS requests before endpoint processing."""
    if request.method == 'OPTIONS':
        response = app.make_default_options_response()
        response.headers['Access-Control-Allow-Origin'] = '*'
        response.headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-Requested-With'
        return response, 204


@app.after_request
def add_cors_headers(response):
    """
    Enable Cross-Origin Resource Sharing (CORS) for the React control panel.
    Allows GET, POST, DELETE, OPTIONS and Content-Type headers.
    """
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-Requested-With'
    return response


@app.route('/api/status', methods=['GET', 'OPTIONS'])
def get_status():
    """
    1. GET /api/status
    Returns system status and dynamic Raspberry Pi IP address.
    """
    if request.method == 'OPTIONS':
        return '', 204
    return jsonify({
        "device": "Raspberry Pi 3",
        "status": "online",
        "ip": get_device_ip(),
        "version": "1.0"
    }), 200


@app.route('/api/media', methods=['GET', 'OPTIONS'])
def list_media():
    """
    2. GET /api/media
    Returns list of media files stored in /home/nsignage/n-signage/media/ sorted by name.
    """
    if request.method == 'OPTIONS':
        return '', 204
    media_list = []
    try:
        files = sorted(os.listdir(config.MEDIA_FOLDER))
        for fname in files:
            filepath = os.path.join(config.MEDIA_FOLDER, fname)
            if os.path.isfile(filepath) and is_allowed_file(fname):
                media_list.append({
                    "name": fname,
                    "url": f"/media/{fname}",
                    "type": get_media_type(fname),
                    "size": os.path.getsize(filepath)
                })
    except Exception as e:
        logger.error(f"Error listing media: {e}")
        return jsonify({"success": False, "error": "Failed to list media"}), 500

    return jsonify({
        "media": media_list,
        "files": media_list
    }), 200


@app.route('/api/upload', methods=['POST', 'OPTIONS'])
def upload_media():
    """
    3. POST /api/upload
    Accepts multipart/form-data uploads.
    Streams upload directly to disk to avoid loading large videos into RAM.
    Does not overwrite existing files accidentally.
    """
    if request.method == 'OPTIONS':
        return '', 204

    if 'file' not in request.files:
        return jsonify({"success": False, "error": "No file part in request"}), 400

    file = request.files['file']
    if not file or file.filename == '':
        return jsonify({"success": False, "error": "No file selected for upload"}), 400

    filename = secure_filename(file.filename)
    if not filename or not is_allowed_file(filename):
        return jsonify({"success": False, "error": "Invalid or unsupported file type"}), 415

    # Avoid overwriting existing files accidentally by suffixing filename
    target_path = os.path.join(config.MEDIA_FOLDER, filename)
    if os.path.exists(target_path):
        base, ext = os.path.splitext(filename)
        counter = 1
        while os.path.exists(os.path.join(config.MEDIA_FOLDER, f"{base}_{counter}{ext}")):
            counter += 1
        filename = f"{base}_{counter}{ext}"
        target_path = os.path.join(config.MEDIA_FOLDER, filename)

    try:
        # Stream chunks directly to disk to preserve Raspberry Pi 3 RAM
        with open(target_path, 'wb') as f:
            while True:
                chunk = file.stream.read(1024 * 1024)  # 1 MB chunk
                if not chunk:
                    break
                f.write(chunk)
        logger.info(f"Uploaded file saved: {filename}")
    except Exception as e:
        logger.error(f"Failed writing uploaded file {filename}: {e}")
        if os.path.exists(target_path):
            os.remove(target_path)
        return jsonify({"success": False, "error": "Failed writing file to SD card"}), 500

    return jsonify({
        "success": True,
        "message": "File uploaded successfully",
        "filename": filename
    }), 201


@app.route('/api/media/<path:filename>', methods=['DELETE', 'OPTIONS'])
def delete_media(filename):
    """
    4. DELETE /api/media/<filename>
    Deletes the specified file securely after validating path safety.
    Handles URL-decoded filenames and preflight OPTIONS.
    """
    if request.method == 'OPTIONS':
        return '', 204

    decoded_filename = unquote(filename)
    safe_name = secure_filename(decoded_filename)
    
    media_dir = os.path.abspath(config.MEDIA_FOLDER)
    
    # Try exact decoded filename first, then safe filename fallback
    target_path = os.path.abspath(os.path.join(media_dir, decoded_filename))
    safe_target_path = os.path.abspath(os.path.join(media_dir, safe_name))

    actual_target = None
    if target_path.startswith(media_dir) and os.path.exists(target_path) and os.path.isfile(target_path):
        actual_target = target_path
    elif safe_name and safe_target_path.startswith(media_dir) and os.path.exists(safe_target_path) and os.path.isfile(safe_target_path):
        actual_target = safe_target_path

    if not actual_target:
        logger.warning(f"Delete requested for missing file: {filename} (decoded: {decoded_filename})")
        return jsonify({"success": False, "error": "Media not found"}), 404

    try:
        os.remove(actual_target)
        logger.info(f"Deleted media file: {actual_target}")
    except Exception as e:
        logger.error(f"Failed deleting file {actual_target}: {e}")
        return jsonify({"success": False, "error": "Failed to delete media file"}), 500

    return jsonify({
        "success": True,
        "message": "Media deleted successfully"
    }), 200


@app.route('/media/<path:filename>', methods=['GET', 'OPTIONS'])
def serve_media(filename):
    """
    5. GET /media/<filename>
    Serves actual video or image file from media directory.
    Supports HTTP range requests for video streaming.
    """
    if request.method == 'OPTIONS':
        return '', 204

    decoded_filename = unquote(filename)
    safe_name = secure_filename(decoded_filename)

    media_dir = os.path.abspath(config.MEDIA_FOLDER)
    target_path = os.path.abspath(os.path.join(media_dir, decoded_filename))
    safe_target_path = os.path.abspath(os.path.join(media_dir, safe_name))

    actual_name = None
    if target_path.startswith(media_dir) and os.path.exists(target_path):
        actual_name = decoded_filename
    elif safe_name and safe_target_path.startswith(media_dir) and os.path.exists(safe_target_path):
        actual_name = safe_name

    if not actual_name:
        return jsonify({"success": False, "error": "File not found"}), 404

    return send_from_directory(config.MEDIA_FOLDER, actual_name)


@app.route('/display', methods=['GET'])
def display_page():
    """
    6. GET /display
    Renders fullscreen digital signage player for TV/Monitor.
    """
    return render_template('display.html')


# Error handlers returning JSON without surfacing tracebacks
@app.errorhandler(400)
def bad_request(e):
    return jsonify({"success": False, "error": "Bad request"}), 400


@app.errorhandler(404)
def not_found(e):
    return jsonify({"success": False, "error": "Resource not found"}), 404


@app.errorhandler(413)
def request_entity_too_large(e):
    return jsonify({"success": False, "error": "File too large"}), 413


@app.errorhandler(415)
def unsupported_media_type(e):
    return jsonify({"success": False, "error": "Unsupported media type"}), 415


@app.errorhandler(500)
def internal_server_error(e):
    logger.error(f"Internal server error: {e}")
    return jsonify({"success": False, "error": "Internal server error"}), 500


if __name__ == '__main__':
    logger.info(f"Starting N Signage Flask Server on {config.HOST}:{config.PORT}")
    app.run(host=config.HOST, port=config.PORT, debug=False)

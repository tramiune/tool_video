import os
import sys
import subprocess
import tarfile
import socket
import time

# --- CONFIGURATION FOR MEO3 VPS ---
VPS_IP = "165.101.47.50"
VPS_PASS = "AZvps@ar21S3!P2"
LOCAL_DIR = "/Users/qtee/Documents/Tramiune/tool_video"

def run_local(cmd):
    print(f"Local Run: {cmd}")
    subprocess.run(cmd, shell=True, check=True)

def run_remote(vps_cmd):
    print(f"Remote Run: {vps_cmd}")
    cmd = f"sshpass -p '{VPS_PASS}' ssh -o StrictHostKeyChecking=no root@{VPS_IP} '{vps_cmd}'"
    try:
        subprocess.run(cmd, shell=True, check=True)
    except Exception as e:
        print(f"SSH execution failed: {e}")

def upload_file(local_path, remote_path):
    print(f"Uploading {local_path} to {remote_path}")
    cmd = f"sshpass -p '{VPS_PASS}' scp -o StrictHostKeyChecking=no {local_path} root@{VPS_IP}:{remote_path}"
    try:
        subprocess.run(cmd, shell=True, check=True)
    except Exception as e:
        print(f"Upload failed: {e}")

def make_tarfile(output_filename, source_dir, exclude_dirs):
    print(f"Creating archive {output_filename} from {source_dir}...")
    with tarfile.open(output_filename, "w:gz") as tar:
        for root, dirs, files in os.walk(source_dir):
            # Exclude directories and hidden files
            dirs[:] = [d for d in dirs if d not in exclude_dirs and not d.startswith('.')]
            for file in files:
                if file.startswith('.'):
                    continue
                full_path = os.path.join(root, file)
                rel_path = os.path.relpath(full_path, source_dir)
                tar.add(full_path, arcname=rel_path)

def wait_for_ssh(ip, port=22, timeout=300):
    start_time = time.time()
    print(f"Waiting for SSH on {ip}:{port} to be ready...")
    while time.time() - start_time < timeout:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(3)
            s.connect((ip, port))
            s.close()
            print("SSH Port is Open! Proceeding with deployment...")
            return True
        except Exception:
            time.sleep(3)
    print("Timed out waiting for SSH port.")
    return False

def main():
    if not wait_for_ssh(VPS_IP):
        sys.exit(1)
        
    # 1. Prepare local archives
    os.makedirs("/tmp/deploy_meo3", exist_ok=True)
    server_tar = "/tmp/deploy_meo3/api-server.tar.gz"
    web_tar = "/tmp/deploy_meo3/web-app.tar.gz"
    
    make_tarfile(server_tar, f"{LOCAL_DIR}/veo3-api-server", ["node_modules", "uploads", "logs"])
    make_tarfile(web_tar, f"{LOCAL_DIR}/veo3-web-app", ["node_modules", "dist"])
    
    # 2. Create app directory on VPS
    run_remote("mkdir -p /root/meo3")
    
    # 3. Upload archives to VPS
    upload_file(server_tar, "/root/meo3/api-server.tar.gz")
    upload_file(web_tar, "/root/meo3/web-app.tar.gz")
    
    # 4. Upload local .env file
    local_env = f"{LOCAL_DIR}/veo3-api-server/.env"
    if os.path.exists(local_env):
        upload_file(local_env, "/root/meo3/.env")
    
    # 5. Extract and Install packages on remote VPS
    setup_commands = [
        # Setup directories
        "mkdir -p /root/meo3/veo3-api-server /root/meo3/veo3-web-app",
        "tar -xzf /root/meo3/api-server.tar.gz -C /root/meo3/veo3-api-server",
        "tar -xzf /root/meo3/web-app.tar.gz -C /root/meo3/veo3-web-app",
        "mv /root/meo3/.env /root/meo3/veo3-api-server/.env",
        
        # Install Ubuntu system packages
        "sudo apt update",
        "curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -",
        "sudo apt-get install -y nodejs ffmpeg",
        "wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb",
        "sudo apt install -y ./google-chrome-stable_current_amd64.deb",
        "sudo apt-get install -y libxss1 libasound2 libatk-bridge2.0-0 libgtk-3-0",
        
        # Install PM2
        "sudo npm install -y -g pm2",
        
        # Build API server dependencies
        "cd /root/meo3/veo3-api-server && npm install",
        
        # Start API server using PM2
        "cd /root/meo3/veo3-api-server && pm2 delete all || true",
        "cd /root/meo3/veo3-api-server && pm2 start src/server.js --name 'veo3-api-server'",
        "pm2 save"
    ]
    
    # Run the setup script on VPS
    run_remote(" && ".join(setup_commands))
    
    print("\n--- DEPLOYMENT FINISHED ---")

if __name__ == "__main__":
    main()

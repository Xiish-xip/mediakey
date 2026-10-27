# Use Node 20 as the base
FROM node:20-slim

# Install Python, Pip, FFmpeg and CA certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp with the "Anti-Block" networking plugins
# --break-system-packages is required on Debian bookworm (PEP 668)
RUN pip3 install --break-system-packages --no-cache-dir -U "yt-dlp[default,curl-cffi]"

# Set working directory
WORKDIR /app

# Copy package files and install production Node dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the rest of the code (server.js and public folder)
COPY . .

ENV NODE_ENV=production

# Match Render's default port
EXPOSE 10000

# Start the engine
CMD ["node", "server.js"]

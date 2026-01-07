# Use Node 20 as the base
FROM node:20-slim

# Install Python, Pip, and FFmpeg (Essential for Apex v7.4)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp with the "Anti-Block" networking plugins
RUN pip3 install --no-cache-dir -U "yt-dlp[default,curl-cffi]"

# Set working directory
WORKDIR /app

# Copy package files and install Node dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the code (server.js and public folder)
COPY . .

# Match Render's default port
EXPOSE 10000

# Start the engine
CMD ["node", "server.js"]
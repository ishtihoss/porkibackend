#!/bin/sh

# Start Node.js application in the background
echo "🚀 Starting Node.js application..."
node src/index.js &
NODE_PID=$!

# Wait for Node.js to be ready
echo "⏳ Waiting for Node.js to start..."
sleep 5

# Start Nginx
echo "🌐 Starting Nginx..."
nginx -g 'daemon off;' &
NGINX_PID=$!

# Function to handle shutdown
shutdown() {
    echo "📴 Shutting down services..."
    kill $NODE_PID
    kill $NGINX_PID
    exit 0
}

# Trap termination signals
trap shutdown SIGTERM SIGINT

# Keep the script running
wait

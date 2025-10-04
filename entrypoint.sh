#!/bin/sh

# Start Nginx in background
nginx

# Start Node.js application
exec node src/index.js

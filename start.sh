#!/bin/bash
touch peers.json
chmod 666 peers.json
if command -v pm2 &>/dev/null; then
	pm2 delete all
	NODE_ENV=production pm2 start bun --name marabu-node --update-env -- start
	pm2 save
	exit 0
fi

if command -v podman-compose &>/dev/null; then
	podman-compose up -d --build
else
	# Fallback for newer podman versions using the 'compose' plugin
	podman compose up -d --build
fi

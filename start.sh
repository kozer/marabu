#!/bin/bash
touch peers.json
chmod 666 peers.json
if command -v podman-compose &>/dev/null; then
	podman-compose up -d --build
else
	# Fallback for newer podman versions using the 'compose' plugin
	podman compose up -d --build
fi

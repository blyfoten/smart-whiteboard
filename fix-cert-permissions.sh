#!/bin/bash
# Run as: sudo ./fix-cert-permissions.sh
# Makes the Let's Encrypt certs for cfor2.asuscomm.com readable by the 'christer' user.

set -e

DOMAIN="cfor2.asuscomm.com"
CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"
ARCHIVE_DIR="/etc/letsencrypt/archive/${DOMAIN}"
USER="christer"

if [ "$(id -u)" -ne 0 ]; then
    echo "Error: run this script with sudo." >&2
    exit 1
fi

# Parent dirs must be traversable by the group before we can reach the files.
chown "root:${USER}" /etc/letsencrypt/live /etc/letsencrypt/archive
chmod 750 /etc/letsencrypt/live /etc/letsencrypt/archive

# The files in live/ are symlinks into archive/; fix permissions on both.
chown -R "root:${USER}" "${CERT_DIR}"
chown -R "root:${USER}" "${ARCHIVE_DIR}"

chmod 750 "${CERT_DIR}"
chmod 750 "${ARCHIVE_DIR}"

# Private key: group-readable only (no world access).
chmod 640 "${ARCHIVE_DIR}"/privkey*.pem
# Certs and chain: group-readable.
chmod 640 "${ARCHIVE_DIR}"/fullchain*.pem "${ARCHIVE_DIR}"/cert*.pem "${ARCHIVE_DIR}"/chain*.pem

echo "Done. Cert files under ${CERT_DIR} are now readable by '${USER}'."

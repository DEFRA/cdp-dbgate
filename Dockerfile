# Lambda sets PORT=8085; DbGate listens on $PORT in docker, so no socat.
# Node mongo driver needs aws4 for MONGODB-AWS. Install it outside DbGate's
# node_modules — npm install in /home/dbgate-docker broke the previous image.
FROM dbgate/dbgate

RUN apt-get update && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/node-extra
RUN npm init -y && npm install aws4
ENV NODE_PATH=/opt/node-extra/node_modules

WORKDIR /home/dbgate-docker
COPY page-head.js /tmp/page-head.js
# Inline page-head.js and hide the Upgrade button at build time (PAGE_HEAD_SCRIPT is not applied under WEB_ROOT).
# The greps fail the build if DbGate drops something this image relies on, incl. commandsSettings for entrypoint.sh.
RUN grep -q 'TabsPanel_buttonUpgrade' public/build/bundle.js \
 && grep -q 'dbgateUsageAnalyticsConsent' public/build/bundle.js \
 && grep -q 'localforage' public/build/bundle.js \
 && grep -q 'openDatabase' public/build/bundle.js \
 && grep -q 'commandsSettings' public/build/bundle.js \
 && { echo '<script>'; cat /tmp/page-head.js; echo '</script><style>[data-testid=TabsPanel_buttonUpgrade]{display:none !important}</style>'; } > /tmp/page-head.html \
 && sed -i -e '/<!--HEAD_SCRIPT-->/{r /tmp/page-head.html' -e 'd}' public/*.html \
 && grep -q 'dbgateUsageAnalyticsConsent' public/index.html \
 && rm /tmp/page-head.js /tmp/page-head.html
COPY audit-log.js mongo-audit-preload.js redis-preload.js redis-key-browser.js /opt/cdp-audit/
COPY cloud-stub.js redis-primary.js /opt/cdp/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]

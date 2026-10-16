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
# Decline usage analytics and hide the "Upgrade to Premium" button. Filled in at build time because DbGate's
# PAGE_HEAD_SCRIPT is not applied on /<WEB_ROOT>/*.html. The greps fail the build if DbGate changes what this needs.
# TODO: use USAGE_ANALYTICS=false once the dbgate/dbgate image supports it.
RUN grep -q 'TabsPanel_buttonUpgrade' public/build/bundle.js \
 && grep -q 'dbgateUsageAnalyticsConsent' public/build/bundle.js \
 && sed -i "s|<!--HEAD_SCRIPT-->|<script>try { localStorage.setItem('dbgateUsageAnalyticsConsent', 'false') } catch (e) {}</script><style>[data-testid=TabsPanel_buttonUpgrade]{display:none !important}</style>|" public/*.html \
 && grep -q 'dbgateUsageAnalyticsConsent' public/index.html
COPY audit-log.js mongo-audit-preload.js redis-preload.js redis-key-browser.js /opt/cdp-audit/
COPY cloud-stub.js redis-primary.js /opt/cdp/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]

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
# Decline usage analytics before bundle.js reads dbgateUsageAnalyticsConsent.
# Fail the build if DbGate no longer has the line we insert after.
RUN sed -i "/window.dbgate_page = '';/a try { localStorage.setItem('dbgateUsageAnalyticsConsent', 'false'); } catch (e) {}" public/index.html \
 && grep -q "dbgateUsageAnalyticsConsent" public/index.html
COPY mongo-audit-preload.js /opt/cdp-audit/mongo-audit-preload.js
COPY cloud-stub.js /opt/cdp/cloud-stub.js
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]

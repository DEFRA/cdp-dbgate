# Lambda sets PORT=8085; DbGate listens on $PORT in docker, so no socat.
# Node mongo driver needs aws4 for MONGODB-AWS. Install it outside DbGate's
# node_modules — npm install in /home/dbgate-docker broke the previous image.
FROM dbgate/dbgate

WORKDIR /opt/node-extra
RUN npm init -y && npm install aws4
ENV NODE_PATH=/opt/node-extra/node_modules

WORKDIR /home/dbgate-docker
# Decline usage analytics before bundle.js reads dbgateUsageAnalyticsConsent.
RUN sed -i "/window.dbgate_page = '';/a try { localStorage.setItem('dbgateUsageAnalyticsConsent', 'false'); } catch (e) {}" public/index.html
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]

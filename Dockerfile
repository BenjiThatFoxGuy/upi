FROM node:22-bookworm-slim AS web-build
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web ./
RUN npm run build

FROM python:3.10-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV FRONTEND_DIST=/app/frontend-dist
ENV UPI_HOST=0.0.0.0
ENV UPI_PORT=8000
WORKDIR /app
COPY server/requirements.txt ./server/requirements.txt
RUN pip install --no-cache-dir -r ./server/requirements.txt
COPY server ./server
COPY --from=web-build /app/web/dist ./frontend-dist
EXPOSE 8000
CMD ["python", "server/app.py"]

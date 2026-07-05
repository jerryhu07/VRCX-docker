FROM node:24-bookworm AS node-build

ARG TARGETARCH

WORKDIR /app

COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY . .
RUN npm run prod-linux
RUN if [ "$TARGETARCH" = "arm64" ]; then \
        node ./src-electron/download-dotnet-runtime.js --arch=arm64 --platform=linux; \
    else \
        node ./src-electron/download-dotnet-runtime.js --arch=x64 --platform=linux; \
    fi

FROM mcr.microsoft.com/dotnet/sdk:9.0 AS dotnet-build

ARG TARGETARCH

WORKDIR /src

COPY . .
COPY --from=node-build /app/node_modules ./node_modules
RUN if [ "$TARGETARCH" = "arm64" ]; then \
        dotnet build Dotnet/VRCX-Electron-arm64.csproj -c Release -p:Platform=ARM64; \
    else \
        dotnet build Dotnet/VRCX-Electron.csproj -c Release -p:Platform=x64; \
    fi

FROM node:24-bookworm-slim AS runtime

ARG TARGETARCH

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libicu72 \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=8080
ENV VRCX_APP_DATA_DIR=/data

COPY package.json package-lock.json Version ./
COPY --from=node-build /app/node_modules ./node_modules
COPY --from=node-build /app/build/html ./build/html
COPY --from=node-build /app/build/Electron/dotnet-runtime ./build/Electron/dotnet-runtime
COPY --from=dotnet-build /src/build/Electron ./build/Electron
COPY src-electron/InteropApi.js ./src-electron/InteropApi.js
COPY headless ./headless

RUN if [ "$TARGETARCH" = "arm64" ]; then \
        cp ./build/Electron/runtimes/linux-arm64/native/libe_sqlite3.so ./build/Electron/libe_sqlite3.so; \
    else \
        cp ./build/Electron/runtimes/linux-x64/native/libe_sqlite3.so ./build/Electron/libe_sqlite3.so; \
        cp ./build/Electron/runtimes/linux-x64/native/SQLite.Interop.dll ./build/Electron/SQLite.Interop.dll; \
    fi
RUN mkdir -p /data

EXPOSE 8080
VOLUME ["/data"]

CMD ["node", "./headless/server.js"]

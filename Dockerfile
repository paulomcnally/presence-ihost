FROM alpine:3.22

RUN apk add --no-cache arp-scan iproute2 iputils python3 tzdata \
    && mkdir -p /data

WORKDIR /app
COPY presence.py /app/presence.py

EXPOSE 8081

ENTRYPOINT ["python3", "-u", "/app/presence.py"]

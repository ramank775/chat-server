#!/bin/bash

start_nats() {
  nats-server -js > /dev/null 2>&1 &
  echo "Nats server started"
}

create_stream () {
  nats str add --subjects="$2" --storage=memory --replicas=1 --ack --retention=limits --discard=old --max-msgs=-1 --max-msgs-per-subject=-1 --max-bytes=-1 --max-age=-1 --max-msg-size=-1 --dupe-window=2m0s --allow-rollup --no-deny-delete --no-deny-purge $1
}

ENV_FILE=${1:-.env}

echo "ENV FILE" $ENV_FILE

source $ENV_FILE

start_nats;

sleep 2s;


create_stream ${NATS_MESSAGE_DELIVERY_STREAM} "${TOPIC_USER_CONNECTION_STATE}.> ${TOPIC_SEND_MESSAGE}.>"
sleep 1s;

create_stream ${NATS_MESSAGE_ROUTER_STREAM} "${TOPIC_NEW_MESSAGE}.>"
sleep 1s;

create_stream ${NATS_GROUP_MESSAGE_ROUTER_STREAM} "${TOPIC_NEW_GROUP_MS}.>"
sleep 1s;

create_stream ${NATS_NOTIFICATION_STREAM} "${TOPIC_NEW_LOGIN}.> ${TOPIC_OFFLINE_MESSAGE}.>"
sleep 1s;

nats str ls

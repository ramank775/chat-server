#!/bin/bash

start_nats() {
  nats-server -js > /dev/null 2>&1 &
  echo "Nats server started"
}

create_stream () {
  nats str add --subjects="$1.>" --storage=memory --replicas=1 --ack --retention=limits --discard=old --max-msgs=-1 --max-msgs-per-subject=-1 --max-bytes=-1 --max-age=-1 --max-msg-size=-1 --dupe-window=2m0s --allow-rollup --no-deny-delete --no-deny-purge $1
}

ENV_FILE=${1:-.env}

echo "ENV FILE" $ENV_FILE

source $ENV_FILE

start_nats;

sleep 2s;

for var in "${!TOPIC_@}"; do
    create_stream ${!var};
    sleep 1s;
done

nats str ls

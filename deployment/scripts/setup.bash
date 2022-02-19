#!/bin/bash

create_env() {
  cp .env.tmpl .env
}

create_firebase_service_file() {
  cp deployment/config/firebase/service.json.example deployment/config/firebase/service.json
}

create_discovery_service_file() {
  cp deployment/config/discovery_service/services.json.example deployment/config/discovery_service/services.json
}


create_env;
create_discovery_service_file;
create_firebase_service_file;

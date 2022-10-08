#!/bin/bash

npm i --location=global statsd

statsd ./deployment/config/statsd/config

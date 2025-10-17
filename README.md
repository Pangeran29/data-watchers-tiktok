# Klini Ku Backend

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Set Up

```bash
# copy the skeleton of .env and pass the actual value
$ cp example.env .env

# make a new pair of RSA356 (2048 bits) public and private key using OpenSSL
$ openssl genpkey -algorithm RSA -out private.pem -pkeyopt rsa_keygen_bits:2048
$ openssl rsa -pubout -in private.pem -out public.pem

# installation 
$ npm install

# running migration  -> npx prisma migrate deploy (for production/stg)
$ npx prisma migrate dev 

# running the app
$ npm run start
```

## Installation

```bash
$ npm install
```

## Running the app

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Test

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Prisma

```bash
# apply migration (make sure to apply migration locally)
$ npx prisma migrate dev

# apply migration in server (prod\stage\dev on cloud)
$ npx prisma migrate deploy
```# data-watchers-tiktok

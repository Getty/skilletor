#!/usr/bin/env perl
use strict;
use warnings;
use Test::More;

for (qw(
  Skilletor
  Skilletor::Backend
  Skilletor::Cache
  Skilletor::Config
  Skilletor::Entry
  Skilletor::Error
  Skilletor::Error::CacheRejected
  Skilletor::Error::Config
  Skilletor::Error::JSON
  Skilletor::Error::Source
  Skilletor::Error::Spec
  Skilletor::Error::Tar
  Skilletor::Error::Target
  Skilletor::FSUtil
  Skilletor::GitEnv
  Skilletor::Gzip
  Skilletor::JSON
  Skilletor::JSON::OrderedHash
  Skilletor::JSString
  Skilletor::Process
  Skilletor::Role::Source
  Skilletor::Source::Git
  Skilletor::Source::Local
  Skilletor::Source::Url
  Skilletor::Spec
  Skilletor::State
  Skilletor::Tar
  Skilletor::Targets
  Skilletor::URL
)) {
  use_ok($_);
}

done_testing;

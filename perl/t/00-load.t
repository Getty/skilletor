#!/usr/bin/env perl
use strict;
use warnings;
use Test::More;

for (qw(
  Skilletor
  Skilletor::Backend
  Skilletor::Bundles
  Skilletor::Cache
  Skilletor::Catalog
  Skilletor::Config
  Skilletor::Entry
  Skilletor::Error
  Skilletor::Error::Bundle
  Skilletor::Error::CacheRejected
  Skilletor::Error::Catalog
  Skilletor::Error::Config
  Skilletor::Error::Frontmatter
  Skilletor::Error::JSON
  Skilletor::Error::Lock
  Skilletor::Error::LockTimeout
  Skilletor::Error::Source
  Skilletor::Error::Spec
  Skilletor::Error::Tar
  Skilletor::Error::Target
  Skilletor::Error::Unsupported
  Skilletor::FSUtil
  Skilletor::Frontmatter
  Skilletor::GitEnv
  Skilletor::Gzip
  Skilletor::JSON
  Skilletor::JSON::OrderedHash
  Skilletor::JSString
  Skilletor::Lock
  Skilletor::Process
  Skilletor::Resolver
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

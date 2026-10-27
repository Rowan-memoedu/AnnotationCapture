#!/bin/sh
f=$(cd $(dirname ${BASH_SOURCE[0]}); pwd )
exec electron43 $f/../lib/e-search/app -n $*

#!/usr/bin/env python3
"""Run tests/oracle.py on the sample and every fixture, grouped by service and namespace.

    python3 -I tests/run_oracle.py

Writes tests/oracle-out/<fixture>.<groupBy>.json (exact-nanosecond reference), plus
tests/oracle-out/js-numbers/<fixture>.<groupBy>.json for the inputs whose timestamps are JSON
numbers above 2^53 (sample-trace, multi-trace): those emulate JSON.parse rounding them to float64,
so a JS dump of the same file should match to the last decimal.
"""
import importlib.util
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, 'oracle-out')

INPUTS = [
    ('sample-trace', os.path.join(ROOT, 'data', 'sample-trace.json')),
    ('otlp-resourcespans', os.path.join(HERE, 'fixtures', 'otlp-resourcespans.json')),
    ('jaeger', os.path.join(HERE, 'fixtures', 'jaeger.json')),
    ('multi-trace', os.path.join(HERE, 'fixtures', 'multi-trace.json')),
    ('errors', os.path.join(HERE, 'fixtures', 'errors.json')),
    ('synthetic-5k', os.path.join(HERE, 'fixtures', 'synthetic-5k.json')),
]
JS_NUMBER_INPUTS = ('sample-trace', 'multi-trace')
GROUPINGS = ('service', 'namespace')


def load_oracle():
    spec = importlib.util.spec_from_file_location('trace_lens_oracle', os.path.join(HERE, 'oracle.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def run(oracle, path, group_by, js_numbers):
    oracle.JS_NUMBERS = js_numbers
    with open(path, 'r', encoding='utf-8') as f:
        doc = json.load(f)
    model = oracle.build_model(oracle.parse(doc)['traces'][0], group_by)
    return oracle.dump(model, model['journey'])


def save(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write('\n')


def main():
    oracle = load_oracle()
    for name, path in INPUTS:
        for gb in GROUPINGS:
            d = run(oracle, path, gb, False)
            save(os.path.join(OUT, '%s.%s.json' % (name, gb)), d)
            print('%-20s %-9s spans=%-5d groups=%-3d hops=%-5d edges=%-4d insights=%d' % (
                name, gb, d['spanCount'], len(d['groups']), len(d['hops']), len(d['edges']), len(d['insights'])))
            if name in JS_NUMBER_INPUTS:
                save(os.path.join(OUT, 'js-numbers', '%s.%s.json' % (name, gb)), run(oracle, path, gb, True))
    oracle.JS_NUMBERS = False


if __name__ == '__main__':
    main()

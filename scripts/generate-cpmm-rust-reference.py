"""Generate differential vectors from the exact matched public Raydium Rust source.
Only source math is compiled; no validator, wallet, provider or transaction is used.
"""
import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile

revision = 'f4b9b26342afe9122d5ff67cd7a4f19ded4ac0a5'
root = pathlib.Path(sys.argv[1]).resolve()
output = pathlib.Path(sys.argv[2]).resolve()
head = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
if head != revision or subprocess.check_output(['git', '-C', str(root), 'status', '--porcelain'], text=True).strip():
    raise SystemExit('Expected clean matched source revision.')
curve = root / 'programs/cp-swap/src/curve'

def item(text, marker):
    start = text.index(marker)
    opening = text.index('{', start)
    depth = 1
    end = opening + 1
    while depth:
        depth += (text[end] == '{') - (text[end] == '}')
        end += 1
    return text[start:end]

calculator = (curve / 'calculator.rs').read_text()
constant = (curve / 'constant_product.rs').read_text()
source = '#[path = ' + json.dumps(str(curve / 'fees.rs')) + '] mod fees;\nuse fees::Fees;\n'
source += item(calculator, 'pub struct SwapResult') + '\nstruct ConstantProductCurve; impl ConstantProductCurve {\n'
source += item(constant, 'pub fn swap_base_input_without_fees') + '\n}\nstruct CurveCalculator; impl CurveCalculator {\n'
source += item(calculator, 'pub fn swap_base_input(') + '\n}\n'
source += r'''
fn main() {
 for x in [101u128, 1000000000000u128] { for y in [101u128, 100000000000u128] {
  for amount in [1u128, 123u128, 1000000u128] { for trade in [0u64, 2500u64] {
   for creator in [0u64, 1000u64] { for on_input in [false, true] {
    match CurveCalculator::swap_base_input(amount,x,y,trade,creator,120000,40000,on_input) {
     None => println!("{}|{}|{}|{}|{}|{}|none",x,y,amount,trade,creator,on_input),
     Some(r) => println!("{}|{}|{}|{}|{}|{}|some|{}|{}|{}|{}|{}|{}|{}",x,y,amount,trade,creator,on_input,r.output_amount,r.trade_fee,r.protocol_fee,r.fund_fee,r.creator_fee,r.new_input_vault_amount,r.new_output_vault_amount),
    }
   }}
  }}
 }}
}
'''
with tempfile.TemporaryDirectory(prefix='cpmm-rust-reference-') as directory:
    harness = pathlib.Path(directory) / 'reference.rs'
    binary = pathlib.Path(directory) / 'reference'
    harness.write_text(source)
    subprocess.run(['/root/.cargo/bin/rustc', '--edition=2021', '-O', '-C', 'overflow-checks=on', str(harness), '-o', str(binary)], check=True)
    lines = subprocess.check_output([str(binary)], text=True).splitlines()
vectors = []
for line in lines:
    p = line.split('|')
    request = dict(inputReserveRaw=p[0], outputReserveRaw=p[1], inputRaw=p[2], tradeFeeMillionths=p[3], creatorFeeMillionths=p[4], creatorFeeOnInput=p[5] == 'true', protocolFeeMillionths='120000', fundFeeMillionths='40000', minimumOutputRaw='1')
    expected = None if p[6] == 'none' else dict(expectedOutputRaw=p[7], tradeFeeRaw=p[8], protocolFeeRaw=p[9], fundFeeRaw=p[10], creatorFeeRaw=p[11], newInputReserveRaw=p[12], newOutputReserveRaw=p[13])
    vectors.append(dict(input=request, expected=expected, accepted=expected is not None and int(expected['expectedOutputRaw']) > 0))
result = dict(format='cpmm-current-rust-reference-v1', sourceRevision=revision, sourceHashes={name: hashlib.sha256((curve/name).read_bytes()).hexdigest() for name in ['calculator.rs', 'constant_product.rs', 'fees.rs']}, vectorCount=len(vectors), vectors=vectors)
output.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(dict(sourceRevision=revision, vectorCount=len(vectors), output=str(output))))

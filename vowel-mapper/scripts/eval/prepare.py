#!/usr/bin/env python3
"""Bounded public-data fetch. No runtime dependency; writes only under --data-dir.
See README for dataset attribution, selection, and limitations.
"""
import argparse, collections, hashlib, io, json, pathlib, re, shutil, subprocess, urllib.request, zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--data-dir', required=True)
args = parser.parse_args()
root = pathlib.Path(args.data_dir).resolve()
root.mkdir(parents=True, exist_ok=True)
# Refuse accidental corpus downloads into a tracked checkout.
if any((parent/'.git').exists() for parent in [root, *root.parents]):
    raise SystemExit('--data-dir must be outside a Git checkout')
if shutil.disk_usage(root).free < 2 * 1024**3:
    raise SystemExit('Require at least 2 GiB free before downloading')

def fetch(url, path, maximum=120_000_000):
    if path.exists(): return
    print('Download', path.name, flush=True)
    with urllib.request.urlopen(url, timeout=60) as source, path.with_suffix(path.suffix+'.part').open('wb') as dest:
        total = 0
        while chunk := source.read(65536):
            total += len(chunk)
            if total > maximum: raise ValueError('download exceeded bound')
            dest.write(chunk)
    path.with_suffix(path.suffix+'.part').replace(path)

def convert(source, target):
    if target.exists(): return
    subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-i', str(source), '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', str(target)], check=True)

# Hillenbrand authorised mirror: preserve licence and provenance next to uncommitted data.
h95 = 'https://raw.githubusercontent.com/santiagobarreda/hillenbrand_et_al_1995/6dd44decc8ef5b537cbb54732a3b00c8fa652e65/'
for name in ['LICENSE', 'README.md', 'h95-alldata.zip']:
    fetch(h95+name, root/('h95-'+name if name != 'h95-alldata.zip' else name), 30_000_000)
if hashlib.sha256((root/'h95-alldata.zip').read_bytes()).hexdigest() != '2560548591e3a726c88549b6dc9d226995616c26874d601c69fee8b9eee9d730':
    raise ValueError('H95 source archive checksum mismatch')
archive = zipfile.ZipFile(root/'h95-alldata.zip')
def rows(name):
    return {cells[0]: list(map(float,cells[1:])) for line in archive.read(name).decode().splitlines() if re.match(r'^[bmwg]\d\d[a-z]{2}\s',line) for cells in [line.split()]}
times, acoustic = rows('timedata.dat'), rows('bigdata.dat')
speakers = {}
for group in 'bmwg':
    ids = sorted({key[:3] for key in times if key.startswith(group)})[:6]
    speakers.update({speaker: 'development' if i%2==0 else 'heldout' for i,speaker in enumerate(ids)})
manifest=[]
for nested in ['men.zip','women.zip','kids.zip']:
    sounds = zipfile.ZipFile(io.BytesIO(archive.read(nested)))
    for name in sorted(sounds.namelist()):
        key=pathlib.Path(name).stem.lower()
        if key[:3] not in speakers or key not in times or key not in acoustic: continue
        original=root/(key+'-16k.wav'); original.write_bytes(sounds.read(name))
        target=root/(key+'.wav'); convert(original,target); original.unlink()
        start,end,c1,c2=times[key]
        data=acoustic[key]
        # bigdata: duration,F0,steady F1,F2,F3, then F1/F2/F3 at 10..80%.
        refs=[{'timeMs':start+(end-start)*p/10,'f1':data[5+(p-1)*3], 'f2':data[6+(p-1)*3], 'f3':data[7+(p-1)*3]} for p in range(1,9)]
        manifest.append({'id':key,'corpus':'hillenbrand','speaker':key[:3],'group':{'b':'boys','m':'men','w':'women','g':'girls'}[key[0]],'split':speakers[key[:3]],'path':target.name,'phones':[{'start':start/1000,'end':end/1000,'phoneme':key[3:],'group':'vowel'}],'references':refs})

# First two rows per speaker from first 200 deterministic dev_clean rows.
# Split speakers within sex strata before looking at acoustic results.
rows_path=root/'librispeech-source-rows.json'
if not rows_path.exists():
    expected_revision='0daa1eb43dda38ee6ce752e785555380e5628f5c'
    current=json.load(urllib.request.urlopen('https://huggingface.co/api/datasets/gilkeyio/librispeech-alignments',timeout=30))['sha']
    if current != expected_revision: raise ValueError('Dataset revision changed; review selection before downloading')
    collected=[]
    for offset in [0,100]:
        url=f'https://datasets-server.huggingface.co/rows?dataset=gilkeyio/librispeech-alignments&config=default&split=dev_clean&offset={offset}&length=100'
        collected += json.load(urllib.request.urlopen(url, timeout=60))['rows']
    rows_path.write_text(json.dumps(collected))
collected=json.loads(rows_path.read_text())
by_speaker=collections.defaultdict(list)
for item in collected:
    row=item['row']
    if not re.fullmatch(r'\d+-\d+-\d+',row['id']): raise ValueError('Unsafe clip id')
    if row['sex'] not in ['M','F']: raise ValueError('Unknown speaker stratum')
    by_speaker[row['id'].split('-')[0]].append((item['row_idx'],row))
split={}
for sex in ['M','F']:
    group=sorted((s for s,items in by_speaker.items() if items[0][1]['sex']==sex),key=int)[:12]
    split.update({s:'development' if i%2==0 else 'heldout' for i,s in enumerate(group)})
for speaker in sorted(split,key=int):
    for index,row in by_speaker[speaker][:2]:
        original=root/(row['id']+'.flac'); target=root/(row['id']+'.wav')
        if not target.exists():
            fetch(row['audio'][0]['src'],original,5_000_000); convert(original,target); original.unlink()
        manifest.append({'id':row['id'],'corpus':'librispeech','speaker':speaker,'group':row['sex'],'split':split[speaker],'path':target.name,'sourceRow':index,'transcript':row['transcript'],'phones':row['phonemes']})
# Real cafeteria noise, single channel only; ZIP discarded after successful extraction.
noise_archive=root/'PCAFETER_16k.zip'
if not (root/'cafeteria.wav').exists():
    fetch('https://zenodo.org/records/1227121/files/PCAFETER_16k.zip?download=1',noise_archive)
    if hashlib.md5(noise_archive.read_bytes()).hexdigest() != '99927d148128254141a9417d051510bb':
        raise ValueError('DEMAND source archive checksum mismatch')
    z=zipfile.ZipFile(noise_archive)
    name=next(n for n in z.namelist() if n.endswith('ch01.wav'))
    (root/'cafeteria.wav').write_bytes(z.read(name))
convert(root/'cafeteria.wav',root/'cafeteria-48k.wav')
if noise_archive.exists(): noise_archive.unlink()
for item in manifest:
    item['sha256']=hashlib.sha256((root/item['path']).read_bytes()).hexdigest()
(root/'manifest.json').write_text(json.dumps({'version':1,'sampleRate':48000,'noise':'cafeteria-48k.wav','noiseSha256':hashlib.sha256((root/'cafeteria-48k.wav').read_bytes()).hexdigest(),'clips':manifest},indent=2))
print('Prepared',len(manifest),'clips;',collections.Counter(m['corpus'] for m in manifest),flush=True)

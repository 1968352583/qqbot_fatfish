#!/usr/bin/env python3
"""Extract a bounded, code-only release into an empty, root-owned directory."""
import io
import os
from pathlib import Path, PurePosixPath
import shutil
import sys
import tarfile


def unpack(stream, destination):
    data = stream.read(8 * 1024 * 1024 + 1)
    if len(data) > 8 * 1024 * 1024:
        raise ValueError('Release archive exceeds 8 MiB')
    target = Path(destination)
    if not target.is_dir() or any(target.iterdir()):
        raise ValueError('Destination must be an empty directory')
    members, names, size = [], set(), 0
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for member in archive:
            name = member.name.rstrip('/')
            path = PurePosixPath(name)
            if (not name or path.is_absolute() or '..' in path.parts or
                    str(path) != name or '\\' in name or name in names):
                raise ValueError('Invalid or duplicate release path')
            if not (member.isfile() or member.isdir()) or member.sparse is not None:
                raise ValueError('Links, devices and sparse files are not allowed')
            allowed = (name == 'package.json' or name == 'scripts/start.sh' or
                       (path.parts[0] in ('src', 'public') and not any(p.startswith('.') for p in path.parts)) or
                       (name.startswith('scripts/lib/') and path.suffix == '.mjs'))
            if member.isdir():
                allowed = name in ('src', 'public', 'scripts', 'scripts/lib')
            if not allowed:
                raise ValueError('Unexpected file in release')
            names.add(name)
            size += member.size
            if len(names) > 1000 or size > 32 * 1024 * 1024:
                raise ValueError('Expanded release exceeds limit')
            members.append(member)
        required = {'package.json', 'src/main.mjs', 'src/server.mjs', 'public/index.html', 'scripts/lib/qq-api.mjs'}
        if not required.issubset({m.name for m in members if m.isfile()}):
            raise ValueError('Release is missing required application files')
        # Validate every header before writing anything. Never restore archive ownership/modes.
        for member in members:
            path = target / member.name
            if member.isdir():
                path.mkdir(mode=0o755, parents=True, exist_ok=True)
            else:
                path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                with archive.extractfile(member) as source, path.open('xb') as output:
                    shutil.copyfileobj(source, output)
                os.chmod(str(path), 0o644)


if __name__ == '__main__':
    try:
        unpack(sys.stdin.buffer, sys.argv[1])
    except (ValueError, OSError, tarfile.TarError) as error:
        sys.exit('Invalid release: {}'.format(error))

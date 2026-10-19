"""Offline package diagnostic: exercise native libraries without opening user data."""
from io import BytesIO
import sqlite3
import ssl

import certifi
import numpy as np
from PIL import Image, ImageCms

from edit_state import BOUNDS, FLAGS, RECIPE_VERSION
from jpeg_codec import decode_jpeg, encode_jpeg
from jpeg_renderer import JpegRenderer


def check_runtime():
    output = BytesIO()
    with Image.new('RGB', (4, 4), (70, 100, 130)) as image:
        image.save(output, 'JPEG', icc_profile=ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes())
    source = decode_jpeg(output.getvalue())
    recipe = {'version': RECIPE_VERSION, 'adjustments': dict.fromkeys(BOUNDS, 0),
              'adjustmentEnabled': dict.fromkeys(BOUNDS, True), **dict.fromkeys(FLAGS, True)}
    recipe['adjustments']['exposure'] = 1
    rendered = JpegRenderer().render(source, recipe)
    assert rendered.pixels != source.pixels
    assert decode_jpeg(encode_jpeg(rendered)).width == 4
    with sqlite3.connect(':memory:') as database:
        assert database.execute('SELECT 1').fetchone() == (1,)
    context = ssl.create_default_context(cafile=certifi.where())
    assert context.cert_store_stats()['x509_ca'] > 0
    return {'jpegIccNumpy': True, 'sqlite': True, 'tlsCaLoaded': True, 'numpy': np.__version__}

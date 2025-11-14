const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');

async function getSuggestions(imagePath) {
  // Prepare the form data with the image file
  const form = new FormData();
  form.append('image', fs.createReadStream(imagePath));  // attach image file

  // Optional: include additional parameters like lat, lng, observed_on (see below)
  form.append('lat', '-22.9068');      // e.g. latitude
  form.append('lng', '-43.1729');     // e.g. longitude
  form.append('observed_on', '2025-10-13'); // date of observation (YYYY-MM-DD)

  // Make the POST request with Authorization header
  const apiToken = '<YOUR_I-NATURALIST_TOKEN>';  // See auth details below
  const response = await axios.post(
    'https://api.inaturalist.org/v1/computervision/score_image',
    form,
    { headers: { 
        'Authorization': `Bearer ${apiToken}`,    // use your JWT or token
        ...form.getHeaders()  // include multipart form headers (boundary)
      }
    }
  );
  return response.data;
}

// Usage:
getSuggestions('photo.jpg').then(data => {
  console.log(data.results);
});

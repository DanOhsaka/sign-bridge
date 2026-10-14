// training/storage.js

(function () {

  function saveTrainingSample(sample) {

    var json = JSON.stringify(sample, null, 2);

    var blob = new Blob(
      [json],
      { type: "application/json" }
    );

    var url = URL.createObjectURL(blob);

    var link = document.createElement("a");

    var safeLabel = sample.label
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "_");

    var timestamp = Date.now();

    link.href = url;

    link.download =
      safeLabel +
      "_" +
      timestamp +
      ".json";

    document.body.appendChild(link);

    link.click();

    document.body.removeChild(link);

    URL.revokeObjectURL(url);
  }

  window.saveTrainingSample =
    saveTrainingSample;

})();
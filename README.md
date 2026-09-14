# OpenReview Active Consoles


Tired of a stack of obsolete **Your Active Consoles** on the [OpenReview](https://openreview.net/) homepage? This is a userscript that helps.

## How it looks

Short list:

<img width="644" height="643" alt="image" src="https://github.com/user-attachments/assets/41bcbb9f-73ad-44ae-9bf4-a64d9bd2ba83" />

Full list:

<img width="625" height="943" alt="image" src="https://github.com/user-attachments/assets/5eaa9744-2f78-4654-9a24-f6a052081b06" />


## Features

- Shows every active console except those hidden with `Hide`.
- Restores hidden consoles through `Show all` and `Restore`.
- Saves hidden consoles locally in the browser.
- Applies local hide/show settings immediately and refreshes sorting in the background.
- Sorts venues by your latest OpenReview activity.
- Uses one API request and caches the result for 15 minutes.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Create a new userscript.
3. Paste the contents of `openreview-active-consoles.user.js` and save.
4. Reload the OpenReview homepage.

## Disable activity sorting

Remove the section between these comments:

```javascript
// OPTIONAL ACTIVITY SORTING — START
// OPTIONAL ACTIVITY SORTING — END
```

Hiding and restoring consoles will continue to work without API requests.

## Author

Nikolay Nikitin

## License

[BSD 3-Clause](LICENSE)

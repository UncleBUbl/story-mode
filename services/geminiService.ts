
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import {
  GoogleGenAI,
  Video,
  VideoGenerationReferenceImage,
  VideoGenerationReferenceType,
} from '@google/genai';
import {GenerateVideoParams, GenerationMode, Resolution, VeoModel} from '../types';

interface GenerationResult {
  objectUrl: string;
  blob: Blob;
  uri: string;
  video: Video;
}

// Helper function to handle the actual API call logic
const performGeneration = async (
  ai: GoogleGenAI,
  params: GenerateVideoParams,
  overridePrompt?: string,
  overrideVideoInput?: Video
): Promise<GenerationResult> => {
  
  const config: any = {
    numberOfVideos: 1,
    resolution: params.resolution,
  };

  // Conditionally add aspect ratio. It's not used for extending videos.
  // Note: For STORY_MODE step 2 (extension), we should ideally treat it like EXTEND_VIDEO implicitly for config purposes,
  // but if we pass `video` param, `generateVideos` treats it as extension.
  // We should NOT pass aspect ratio if we are extending.
  const isExtensionOperation = params.mode === GenerationMode.EXTEND_VIDEO || !!overrideVideoInput;

  if (!isExtensionOperation) {
    config.aspectRatio = params.aspectRatio;
  } else {
     // When extending, we must match the resolution of 720p (which is already enforced by UI/params)
     // and typically we inherit aspect ratio, but passing it might be ignored or cause error if mismatched.
     // Safer to omit it for extension operations as per examples.
  }

  const generateVideoPayload: any = {
    model: params.model,
    config: config,
  };

  let activePrompt = overridePrompt || params.prompt;
  
  // Append reference descriptions to the prompt if they exist, to guide the AI.
  // We only do this for the initial generation (not extensions, unless specifically needed, but usually context is set in step 1).
  if (!isExtensionOperation && params.referenceImages?.length) {
     const refDescriptions = params.referenceImages
        .map((img, idx) => img.description ? `(Reference ${idx + 1}: ${img.description})` : null)
        .filter(Boolean)
        .join(' ');
     
     if (refDescriptions) {
        activePrompt = activePrompt ? `${activePrompt} ${refDescriptions}` : refDescriptions;
     }
  }

  if (activePrompt) {
    generateVideoPayload.prompt = activePrompt;
  }

  if (overrideVideoInput) {
     generateVideoPayload.video = overrideVideoInput;
     console.log('Generating extension/sequence from previous video object.');
  } else if (params.mode === GenerationMode.FRAMES_TO_VIDEO) {
    if (params.startFrame) {
      generateVideoPayload.image = {
        imageBytes: params.startFrame.base64,
        mimeType: params.startFrame.file.type,
      };
      console.log(
        `Generating with start frame: ${params.startFrame.file.name}`,
      );
    }

    const finalEndFrame = params.isLooping
      ? params.startFrame
      : params.endFrame;
    if (finalEndFrame) {
      generateVideoPayload.config.lastFrame = {
        imageBytes: finalEndFrame.base64,
        mimeType: finalEndFrame.file.type,
      };
    }
  } else if (params.mode === GenerationMode.REFERENCES_TO_VIDEO || (params.mode === GenerationMode.STORY_MODE && params.referenceImages?.length)) {
     // Handle references for R2V OR Story Mode (first step only)
     // We only add references if we are NOT extending (extension is handled via overrideVideoInput check above)
     if (!isExtensionOperation) {
        const referenceImagesPayload: VideoGenerationReferenceImage[] = [];
        if (params.referenceImages) {
          for (const img of params.referenceImages) {
            referenceImagesPayload.push({
              image: {
                imageBytes: img.base64,
                mimeType: img.file.type,
              },
              referenceType: VideoGenerationReferenceType.ASSET,
            });
          }
        }
        if (params.styleImage) {
          referenceImagesPayload.push({
            image: {
              imageBytes: params.styleImage.base64,
              mimeType: params.styleImage.file.type,
            },
            referenceType: VideoGenerationReferenceType.STYLE,
          });
        }
        if (referenceImagesPayload.length > 0) {
          generateVideoPayload.config.referenceImages = referenceImagesPayload;
        }
     }
  } else if (params.mode === GenerationMode.EXTEND_VIDEO) {
    if (params.inputVideoObject) {
      generateVideoPayload.video = params.inputVideoObject;
      console.log(`Generating extension from input video object.`);
    } else {
      throw new Error('An input video object is required to extend a video.');
    }
  }

  console.log('Submitting video generation request...', generateVideoPayload);
  let operation = await ai.models.generateVideos(generateVideoPayload);
  console.log('Video generation operation started:', operation);

  while (!operation.done) {
    await new Promise((resolve) => setTimeout(resolve, 10000));
    console.log('...Generating...');
    operation = await ai.operations.getVideosOperation({operation: operation});
  }

  if (operation?.response) {
    const videos = operation.response.generatedVideos;
    if (!videos || videos.length === 0) {
      throw new Error('No videos were generated.');
    }

    const firstVideo = videos[0];
    if (!firstVideo?.video?.uri) {
      throw new Error('Generated video is missing a URI.');
    }
    const videoObject = firstVideo.video;
    const url = decodeURIComponent(videoObject.uri);
    
    // Fix: The API key for fetching the video must also come from process.env.API_KEY.
    const res = await fetch(`${url}&key=${process.env.API_KEY}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch video: ${res.status} ${res.statusText}`);
    }

    const videoBlob = await res.blob();
    const objectUrl = URL.createObjectURL(videoBlob);

    return {objectUrl, blob: videoBlob, uri: url, video: videoObject};
  } else {
    console.error('Operation failed:', operation);
    throw new Error('No videos generated.');
  }
}

export const generateVideo = async (
  params: GenerateVideoParams,
): Promise<GenerationResult> => {
  console.log('Starting video generation with params:', params);

  const ai = new GoogleGenAI({apiKey: process.env.API_KEY});

  if (params.mode === GenerationMode.STORY_MODE && params.storyPrompts && params.storyPrompts.length > 0) {
    console.log(`Starting Story Mode Sequence with ${params.storyPrompts.length} parts...`);
    
    let currentResult: GenerationResult | null = null;

    // Iterate through all story prompts
    for (let i = 0; i < params.storyPrompts.length; i++) {
        const currentPrompt = params.storyPrompts[i];
        console.log(`Step ${i + 1}/${params.storyPrompts.length}: Generating... Prompt: "${currentPrompt}"`);
        
        if (i === 0) {
            // First Step: Treat as T2V (or Reference to Video if refs are present)
            // performGeneration will handle adding references if params.referenceImages exists
            currentResult = await performGeneration(ai, {
                ...params,
                mode: GenerationMode.STORY_MODE, // Keeps config logic intact
                prompt: currentPrompt
            });
        } else {
            // Subsequent Steps: Extension
            if (!currentResult) throw new Error("Previous step failed to produce a result.");
            
            // We use the video object from the previous result to extend it
            // This ensures seamless transition as the model sees the previous video context
            currentResult = await performGeneration(
                ai,
                params,
                currentPrompt, // Override prompt
                currentResult.video // Override input video with previous result
            );
        }
        console.log(`Step ${i + 1} Complete.`);
    }

    if (!currentResult) {
        throw new Error("Story Mode failed to generate any video.");
    }
    
    console.log("Story Mode Sequence Complete.");
    return currentResult;
    
  } else {
    // Normal single-step generation
    return performGeneration(ai, params);
  }
};
